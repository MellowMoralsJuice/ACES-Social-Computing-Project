/**
 * useGym — everything the participant view knows about the gym.
 *
 * - Loads the station's breadcrumbs, cached in the browser so
 *   a flaky classroom network shows saved content instead of a spinner.
 * - Keeps session state live: Supabase Realtime tells the phone "something
 *   changed", and the phone refetches. If Realtime is not connected it polls
 *   the one lightweight /api/state endpoint every 2 seconds.
 * - Exposes the decay clock (virtual time), re-evaluated once a second, so
 *   freshness is always derived on read and tips fade on a real timer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { applyInteraction, freshnessAt, rankScore, virtualNowMs, type DecayClock } from '../../shared/decay';
import { SEED_BREADCRUMBS, SEED_CONTRIBUTORS, STATION, seedTextHash } from '../../shared/seed';
import type {
  Breadcrumb,
  BreadcrumbsResponse,
  CreateBreadcrumbResponse,
  SessionInfo,
  Settings,
  StateResponse,
  Station,
  VoteValue,
} from '../../shared/types';
import { ApiFailure, api } from './api';
import { startRealtime } from './realtime';
import { KEYS, loadJson, saveJson } from './storage';

const POLL_FALLBACK_MS = 2000; // Realtime unavailable
const POLL_HEARTBEAT_MS = 6000; // Realtime connected: a slow safety net only
const TICK_MS = 1000;

interface CachedContent {
  station: Station;
  breadcrumbs: Breadcrumb[];
  saved_at: number;
}

/** Bundled copy of the seed, used only if this phone has never reached the server. */
function bundledContent(): CachedContent {
  const now = Date.now();
  const hour = 3_600_000;
  return {
    station: STATION,
    saved_at: now,
    breadcrumbs: SEED_BREADCRUMBS.map((b) => {
      const c = SEED_CONTRIBUTORS.find((x) => x.id === b.contributor_id)!;
      return {
        id: b.id,
        station_id: STATION.id,
        kind: b.kind,
        body: b.body,
        audio_url: b.audio_url,
        audio_seconds: b.audio_seconds,
        contributor_id: c.id,
        base_freshness: b.base_freshness,
        last_interaction_at: new Date(now - b.lastInteractionHoursAgo * hour).toISOString(),
        created_at: new Date(now - b.createdHoursAgo * hour).toISOString(),
        is_verified: b.is_verified,
        is_flagged: b.is_flagged,
        helped_count: b.helped_count,
        useful_count: b.useful_count,
        not_useful_count: b.not_useful_count,
        rank_score: 0,
        tags: b.tags,
        text_hash: seedTextHash(b),
        pin_state: 'none' as const,
        duplicate_count: 1,
        contributor: { ...c, is_seeded: true },
        my_vote: null,
        my_helped: false,
        my_note: null,
        thanks_notes: null,
      };
    }),
  };
}

/** What the add flow sends: a typed tip, a recording, or text to be read aloud (audio with no clip). */
export interface NewBreadcrumb {
  kind: 'text' | 'audio';
  body?: string;
  tags?: string[];
  audio?: { data: string; mime: string; seconds: number };
}

export interface Gym {
  station: Station;
  breadcrumbs: Breadcrumb[];
  settings: Settings;
  clock: DecayClock;
  /** Scripted per-phone skip already applied (seconds). */
  skipSeconds: number;
  offline: boolean;
  realtime: boolean;
  /** The server no longer knows this session (it was reset). */
  sessionLost: boolean;
  /** False until the first state answer (or failure) arrives. */
  synced: boolean;
  vote: (id: string, value: VoteValue) => Promise<void>;
  /** "Helped me". The count moves once per participant; a note can be sent with it or added afterwards. */
  markHelped: (id: string, note?: string) => Promise<void>;
  addBreadcrumb: (input: NewBreadcrumb) => Promise<CreateBreadcrumbResponse>;
  scriptedSkip: () => Promise<void>;
}

export function useGym(session: SessionInfo | null, stationCode: string): Gym {
  const cached = useMemo(() => {
    const saved = loadJson<CachedContent>(KEYS.content);
    return saved && saved.breadcrumbs?.length ? saved : bundledContent();
  }, []);
  const [station, setStation] = useState<Station>(cached.station);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>(cached.breadcrumbs);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [skipSeconds, setSkipSeconds] = useState(session?.clock_skip_seconds ?? 0);
  const [offline, setOffline] = useState(false);
  const [realtime, setRealtime] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);
  const [synced, setSynced] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const sessionId = session?.id ?? null;
  const skew = useRef(0); // server clock minus this phone's clock
  const contentRev = useRef(-1);
  const loadingContent = useRef(false);
  const skipAppliedAt = useRef(0);

  const loadBreadcrumbs = useCallback(async () => {
    if (loadingContent.current) return;
    loadingContent.current = true;
    try {
      const query = `station=${encodeURIComponent(stationCode)}${sessionId ? `&session_id=${sessionId}` : ''}`;
      const data = await api.get<BreadcrumbsResponse>(`/api/breadcrumbs?${query}`);
      contentRev.current = data.content_rev;
      setBreadcrumbs(data.breadcrumbs);
      setOffline(false);
    } catch (error) {
      if (error instanceof ApiFailure && error.offline) setOffline(true);
    } finally {
      loadingContent.current = false;
    }
  }, [sessionId, stationCode]);

  const pollState = useCallback(async () => {
    const startedAt = Date.now();
    try {
      const data = await api.get<StateResponse>(`/api/state${sessionId ? `?session_id=${sessionId}` : ''}`);
      skew.current = new Date(data.server_now).getTime() - Date.now();
      setSettings(data.settings);
      setOffline(false);
      setSynced(true);
      if (sessionId) {
        setSessionLost(!data.session_found);
        // The server owns this value (an admin "Reset time" clears it). The one exception is an
        // answer that was already on its way when this phone's scripted skip landed.
        if (startedAt >= skipAppliedAt.current) setSkipSeconds(data.clock_skip_seconds);
      }
      if (data.settings.content_rev !== contentRev.current) void loadBreadcrumbs();
    } catch (error) {
      if (error instanceof ApiFailure && error.offline) setOffline(true);
      setSynced(true);
    }
  }, [sessionId, loadBreadcrumbs]);

  // First load: the station (it rarely changes), then breadcrumbs and state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<{ station: Station }>(`/api/stations?code=${encodeURIComponent(stationCode)}`);
        if (!cancelled) setStation(data.station);
      } catch (error) {
        if (!cancelled && error instanceof ApiFailure && error.offline) setOffline(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stationCode]);

  // Keep the browser cache current so the next (possibly offline) start has content.
  useEffect(() => {
    if (breadcrumbs.length === 0) return;
    const content: CachedContent = { station, breadcrumbs, saved_at: Date.now() };
    saveJson(KEYS.content, content);
  }, [station, breadcrumbs]);

  // A new session resets the per-phone skip.
  useEffect(() => {
    setSkipSeconds(session?.clock_skip_seconds ?? 0);
    setSessionLost(false);
    contentRev.current = -1;
  }, [session?.id, session?.clock_skip_seconds]);

  // Live updates: Realtime "changed" signal, plus polling (fast when Realtime is down).
  useEffect(() => {
    void pollState();
    const handle = startRealtime(() => void pollState(), setRealtime);
    return () => handle.stop();
  }, [pollState]);

  useEffect(() => {
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void pollState();
      },
      realtime ? POLL_HEARTBEAT_MS : POLL_FALLBACK_MS,
    );
    return () => window.clearInterval(interval);
  }, [realtime, pollState]);

  // The decay timer: re-read "now" once a second. Nothing is written anywhere.
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(interval);
  }, []);

  const clock = useMemo<DecayClock>(
    () => ({
      nowMs: virtualNowMs(nowMs + skew.current, settings.virtual_clock_offset_seconds, skipSeconds),
      busyness: settings.gym_busyness,
      multiplier: settings.decay_multiplier,
      skipActive: settings.virtual_clock_offset_seconds + skipSeconds > 0,
    }),
    [nowMs, settings.virtual_clock_offset_seconds, settings.gym_busyness, settings.decay_multiplier, skipSeconds],
  );
  const clockRef = useRef(clock);
  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

  const replace = useCallback((next: Breadcrumb) => {
    setBreadcrumbs((list) => (list.some((b) => b.id === next.id) ? list.map((b) => (b.id === next.id ? next : b)) : [next, ...list]));
  }, []);

  const vote = useCallback(
    async (id: string, value: VoteValue) => {
      if (!sessionId) return;
      let before: Breadcrumb | undefined;
      // Optimistic update with the same pure functions the server uses.
      setBreadcrumbs((list) =>
        list.map((b) => {
          if (b.id !== id || b.my_vote === value) return b;
          before = b;
          const next = {
            ...b,
            ...applyInteraction(b, value, clockRef.current),
            useful_count: b.useful_count + (value === 'useful' ? 1 : 0) - (b.my_vote === 'useful' ? 1 : 0),
            not_useful_count: b.not_useful_count + (value === 'not_useful' ? 1 : 0) - (b.my_vote === 'not_useful' ? 1 : 0),
            my_vote: value,
          };
          return {
            ...next,
            rank_score: rankScore({ ...next, has_loaf_badge: b.contributor.has_loaf_badge }, freshnessAt(next, clockRef.current)),
          };
        }),
      );
      try {
        const data = await api.post<{ breadcrumb: Breadcrumb }>('/api/votes', { session_id: sessionId, breadcrumb_id: id, value });
        replace(data.breadcrumb);
      } catch (error) {
        if (before) replace(before);
        throw error;
      }
    },
    [sessionId, replace],
  );

  const markHelped = useCallback(
    async (id: string, note?: string) => {
      if (!sessionId) return;
      let before: Breadcrumb | undefined;
      setBreadcrumbs((list) =>
        list.map((b) => {
          if (b.id !== id) return b;
          before = b;
          // The count and freshness move only on the first thanks; a note added later changes neither.
          const counted = b.my_helped
            ? b
            : { ...b, ...applyInteraction(b, 'helped', clockRef.current), helped_count: b.helped_count + 1, my_helped: true };
          return note && !b.my_note ? { ...counted, my_note: note } : counted;
        }),
      );
      try {
        const data = await api.post<{ breadcrumb: Breadcrumb }>('/api/helped', {
          session_id: sessionId,
          breadcrumb_id: id,
          ...(note ? { note } : {}),
        });
        replace(data.breadcrumb);
      } catch (error) {
        if (before) replace(before);
        throw error;
      }
    },
    [sessionId, replace],
  );

  const addBreadcrumb = useCallback(
    async (input: NewBreadcrumb) => {
      const data = await api.post<CreateBreadcrumbResponse>('/api/breadcrumbs', {
        session_id: sessionId,
        station: stationCode,
        ...input,
      });
      replace(data.breadcrumb);
      return data;
    },
    [sessionId, stationCode, replace],
  );

  const scriptedSkip = useCallback(async () => {
    if (!sessionId) return;
    const data = await api.post<{ clock_skip_seconds: number }>('/api/state', { session_id: sessionId, action: 'scripted_skip' });
    skipAppliedAt.current = Date.now();
    setSkipSeconds(data.clock_skip_seconds);
  }, [sessionId]);

  return {
    station,
    breadcrumbs,
    settings,
    clock,
    skipSeconds,
    offline,
    realtime,
    sessionLost,
    synced,
    vote,
    markHelped,
    addBreadcrumb,
    scriptedSkip,
  };
}
