/**
 * The main view through the glasses.
 *
 * Closed, the view is almost empty: the station's name in the top left, a
 * Breadcrumbs button on the right (loaf icon and a count) and a Finish button.
 * The middle of the lens stays clear so the room is what you look at.
 *
 * Breadcrumbs opens a panel: from the right when the phone is sideways (the
 * room stays visible on the left), from the bottom when it is upright. Inside
 * are two tabs, Text and Audio. The panel opens with neither tab chosen, so
 * which one a participant goes to first is their own choice (it is logged,
 * and the survey asks about it).
 *
 * The experience runs itself: look around -> open tips -> "one week later"
 * -> survey. The admin panel can fast-forward time and pin tips, but nobody
 * has to touch it.
 *
 * Wording note: nothing on screen explains WHY tips fade. The survey asks
 * participants what they think a faded tip means, so the interface shows the
 * fading and the time passing, and leaves the conclusion to them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DAY_SECONDS } from '../../shared/decay';
import type { BreadcrumbKind, CreateBreadcrumbResponse, SessionInfo, VoteValue } from '../../shared/types';
import { ApiFailure } from '../lib/api';
import { crumbLabel, liveCount, offsetLabel, tabList, viewOf, type CrumbView } from '../lib/crumbs';
import { buzz } from '../lib/feedback';
import { checkAudioFiles, pause, play, setPlaybackReporter, stop as stopAudio, usePlayer, usesSpeech } from '../lib/player';
import { KEYS, loadJson, saveJson } from '../lib/storage';
import { track } from '../lib/tracker';
import type { Gym } from '../lib/useGym';
import { AddBreadcrumb } from './AddBreadcrumb';
import { BreadcrumbList, TagFilters } from './BreadcrumbList';
import type { CameraStatus } from './Camera';
import {
  IconArrow,
  IconBack,
  IconCamera,
  IconCheck,
  IconClock,
  IconClose,
  IconLoaf,
  IconMic,
  IconPhoneTurn,
  IconPin,
  IconPlus,
  IconText,
} from './Icons';
import { Sheet } from './Sheet';

type PanelName = 'list' | 'add' | null;

/** Seconds of looking at tips before the scripted time-skip plays. */
const SKIP_AFTER_VIEW_SECONDS = 20;
const BANNER_MS = 2800;
const TOAST_MS = 2600;
const STATE_ORDER = ['fresh', 'fading', 'stale', 'gone'];
const KIND_LABEL: Record<BreadcrumbKind, string> = { text: 'Text', audio: 'Audio' };

export type SurveyFact = 'posted' | 'playedAudio';

interface Props {
  session: SessionInfo;
  gym: Gym;
  /** The phone is upright: no glasses frame, the panel is a bottom sheet. */
  portrait: boolean;
  camera: { on: boolean; status: CameraStatus };
  onCameraRetry: () => void;
  onFinish: () => void;
  /** Things this participant did that decide which survey follow-ups they get. */
  onFact: (fact: SurveyFact) => void;
}

export function Scene({ session, gym, portrait, camera, onCameraRetry, onFinish, onFact }: Props) {
  const { settings, clock, breadcrumbs, scriptedSkip } = gym;
  const myContributorId = session.contributor.id;
  const player = usePlayer();

  const [panel, setPanel] = useState<PanelName>(null);
  const [tab, setTab] = useState<BreadcrumbKind | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [pinnedFirstId, setPinnedFirstId] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [showMore, setShowMore] = useState<Partial<Record<BreadcrumbKind, boolean>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  /** New tips arrived from someone else: the Breadcrumbs button pulses until the panel is opened. */
  const [pulsing, setPulsing] = useState(false);
  const [cameraAsked, setCameraAsked] = useState(false);
  // One-time hints, remembered per participant (a phone is handed from person to person).
  const [loafHintSeen, setLoafHintSeen] = useState(() => loadJson<string>(KEYS.loafHint) === session.id);
  const [turnHintGone, setTurnHintGone] = useState(() => loadJson<string>(KEYS.turnHint) === session.id);

  const viewedSeconds = useRef(0);
  const skipStarted = useRef(gym.skipSeconds > 0);
  const firstTabLogged = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const viewedTips = useRef(new Set<string>());
  // What is open right now, readable inside callbacks without re-creating them.
  const open = useRef<{ panel: PanelName; tab: BreadcrumbKind | null; panelAt: number | null; tabAt: number | null }>({
    panel: null,
    tab: null,
    panelAt: null,
    tabAt: null,
  });

  const say = useCallback((message: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  // --- Derived lists (freshness and rank are computed here, on read) -------------
  const counts = useMemo(
    () => ({ text: liveCount(breadcrumbs, clock, 'text'), audio: liveCount(breadcrumbs, clock, 'audio') }),
    [breadcrumbs, clock],
  );
  const total = counts.text + counts.audio;
  const list = useMemo(
    () => (tab ? tabList(breadcrumbs, clock, tab, tag, pinnedFirstId) : null),
    [breadcrumbs, clock, tab, tag, pinnedFirstId],
  );
  const listShowing = panel === 'list' && tab !== null;

  // --- Audio ---------------------------------------------------------------------------
  // Find out ahead of time which starting clips have a sound file, so a tap can go straight to the right voice.
  const audioUrls = useMemo(
    () =>
      breadcrumbs
        .map((b) => b.audio_url)
        .filter((url): url is string => Boolean(url && url.startsWith('/audio/')))
        .join(','),
    [breadcrumbs],
  );
  useEffect(() => {
    if (audioUrls) void checkAudioFiles(audioUrls.split(','));
  }, [audioUrls]);

  useEffect(() => {
    setPlaybackReporter((report) =>
      track(
        'audio_stopped',
        { listened_ms: report.listened_ms, completed: report.completed, mode: report.mode, reason: report.reason },
        report.id,
      ),
    );
    // Leaving the main view for any reason (survey, reset) silences the player.
    return () => {
      stopAudio('closed');
      setPlaybackReporter(() => undefined);
    };
  }, []);

  const togglePlay = (view: CrumbView) => {
    const { crumb } = view;
    if (player.id === crumb.id && player.playing) {
      pause();
      return;
    }
    const resuming = player.id === crumb.id;
    play(crumb);
    if (!resuming) {
      track(
        'audio_started',
        { mode: usesSpeech(crumb) ? 'speech' : 'file', loaf: crumb.contributor.has_loaf_badge, state: view.state },
        crumb.id,
      );
      onFact('playedAudio');
    }
  };

  // --- Opening and closing, with logging ----------------------------------------------
  const logTabLeft = useCallback(() => {
    const now = open.current;
    if (now.tab && now.tabAt !== null) track('tab_closed', { tab: now.tab, duration_ms: Date.now() - now.tabAt });
    now.tabAt = null;
  }, []);

  const logPanelLeft = useCallback(() => {
    logTabLeft();
    const now = open.current;
    if (now.panel && now.panelAt !== null) track('panel_closed', { duration_ms: Date.now() - now.panelAt });
    now.panelAt = null;
  }, [logTabLeft]);

  // Leaving the scene any way at all (survey started remotely, reset) still closes out the log.
  useEffect(() => () => logPanelLeft(), [logPanelLeft]);

  const openPanel = () => {
    buzz(20);
    open.current.panel = 'list';
    open.current.panelAt = Date.now();
    // Coming back to a tab that was already chosen counts as looking at it again.
    if (open.current.tab) open.current.tabAt = Date.now();
    track('panel_opened', { tab: open.current.tab });
    setPanel('list');
    setPulsing(false);
    setConfirming(false);
  };

  const closePanel = useCallback(() => {
    stopAudio('closed');
    if (open.current.panel === 'add') track('add_cancelled', {});
    logPanelLeft();
    open.current.panel = null;
    setPanel(null);
  }, [logPanelLeft]);

  const chooseTab = useCallback(
    (next: BreadcrumbKind, via: 'tap' | 'post' = 'tap') => {
      if (open.current.tab !== next || open.current.tabAt === null) {
        // Only one clip at a time, and none carries over to the other tab.
        stopAudio('switched');
        logTabLeft();
        open.current.tabAt = Date.now();
        track('tab_opened', { tab: next, first: !firstTabLogged.current, via });
        firstTabLogged.current = true;
      }
      open.current.tab = next;
      setTab(next);
      setTag(null);
    },
    [logTabLeft],
  );

  // Log each tip once, the first time it is actually in this participant's list.
  const shownIds = useMemo(() => {
    if (!listShowing || !list || !tab) return '';
    const shown = showMore[tab] ? [...list.top, ...list.more] : list.top;
    return shown.map((view) => view.crumb.id).join(',');
  }, [listShowing, list, tab, showMore]);
  useEffect(() => {
    if (!shownIds || !list || !tab) return;
    for (const view of [...list.top, ...list.more]) {
      const { crumb } = view;
      if (!shownIds.includes(crumb.id) || viewedTips.current.has(crumb.id)) continue;
      viewedTips.current.add(crumb.id);
      track(
        'tip_viewed',
        {
          kind: crumb.kind,
          loaf: crumb.contributor.has_loaf_badge,
          verified: crumb.is_verified,
          flagged: crumb.is_flagged,
          state: view.state,
          helped_count: crumb.helped_count,
        },
        crumb.id,
      );
    }
    // The list changes every second with the clock; only the set of ids on screen matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds]);

  // The one-time Loaf hint: shown the first time a Loaf chip is actually on screen.
  const loafOnScreen = Boolean(
    shownIds && list && [...list.top, ...list.more].some((v) => shownIds.includes(v.crumb.id) && v.crumb.contributor.has_loaf_badge),
  );
  const showLoafHint = loafOnScreen && !loafHintSeen;
  useEffect(() => {
    if (showLoafHint) track('loaf_hint_seen', {});
  }, [showLoafHint]);
  const dismissLoafHint = () => {
    buzz();
    saveJson(KEYS.loafHint, session.id);
    setLoafHintSeen(true);
  };

  // Count how long tips have been on screen (drives the scripted skip).
  useEffect(() => {
    if (!listShowing) return;
    const interval = window.setInterval(() => {
      viewedSeconds.current += 1;
    }, 1000);
    return () => window.clearInterval(interval);
  }, [listShowing]);

  // --- Time-skips --------------------------------------------------------------------
  const showBanner = useCallback((label: string) => {
    buzz(30);
    setBanner(label);
    window.setTimeout(() => setBanner(null), BANNER_MS);
  }, []);

  // A resumed session (page refresh) that already had its scripted skip must not play it twice.
  useEffect(() => {
    if (gym.skipSeconds > 0) skipStarted.current = true;
  }, [gym.skipSeconds]);

  const canAutoSkip = settings.auto_skip_enabled && gym.synced && !gym.offline;

  /** The scripted "One week later": lets a participant see decay with nobody steering. */
  const runScriptedSkip = useCallback(async () => {
    if (skipStarted.current) return;
    skipStarted.current = true;
    showBanner('One week later');
    try {
      await scriptedSkip();
      track('time_skip_seen', { seconds: 7 * DAY_SECONDS, source: 'scripted' });
    } catch {
      skipStarted.current = false; // offline or turned off: try again later, quietly
      setBanner(null);
    }
  }, [scriptedSkip, showBanner]);

  useEffect(() => {
    if (!canAutoSkip || skipStarted.current || !listShowing) return;
    const interval = window.setInterval(() => {
      if (viewedSeconds.current >= SKIP_AFTER_VIEW_SECONDS) void runScriptedSkip();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [canAutoSkip, listShowing, runScriptedSkip]);

  // An admin Fast-forward arrives as a bigger global offset: show the same banner.
  const lastOffset = useRef<number | null>(null);
  useEffect(() => {
    if (!gym.synced) return;
    const offset = settings.virtual_clock_offset_seconds;
    if (lastOffset.current !== null && offset > lastOffset.current) {
      const days = Math.round((offset - lastOffset.current) / DAY_SECONDS);
      showBanner(days >= 30 ? 'One month later' : days >= 7 ? 'One week later' : 'One day later');
      track('time_skip_seen', { seconds: offset - lastOffset.current, source: 'admin' });
    }
    lastOffset.current = offset;
  }, [settings.virtual_clock_offset_seconds, gym.synced, showBanner]);

  // Log which breadcrumbs faded on this phone. The first synced pass only records
  // the starting states, so loading the page never logs a fade that nobody saw.
  const lastStates = useRef<Map<string, string> | null>(null);
  const lastSkipTotal = useRef(0);
  const totalOffset = settings.virtual_clock_offset_seconds + gym.skipSeconds;
  useEffect(() => {
    if (!gym.synced) return;
    const first = lastStates.current === null;
    const states = lastStates.current ?? new Map<string, string>();
    const skipped = totalOffset > lastSkipTotal.current;
    for (const crumb of breadcrumbs) {
      const view = viewOf(crumb, clock);
      const previous = states.get(crumb.id);
      if (!first && previous && STATE_ORDER.indexOf(view.state) > STATE_ORDER.indexOf(previous)) {
        track(
          'breadcrumb_faded',
          {
            from: previous,
            state: view.state,
            freshness: Math.round(view.freshness),
            label: crumbLabel(crumb),
            kind: crumb.kind,
            cause: skipped ? 'time_skip' : 'vote_or_time',
          },
          crumb.id,
        );
        // A clip that fades out of the list stops talking.
        if (view.state === 'gone' && player.id === crumb.id) stopAudio('closed');
      }
      states.set(crumb.id, view.state);
    }
    lastStates.current = states;
    lastSkipTotal.current = totalOffset;
  }, [breadcrumbs, clock, gym.synced, totalOffset, player.id]);

  // --- Live arrivals: a tip someone else just posted, a thank-you on one of mine -------
  const knownIds = useRef<Set<string> | null>(null);
  const knownNotes = useRef<number | null>(null);
  useEffect(() => {
    if (!gym.synced) return;
    const before = knownIds.current;
    if (before) {
      const arrived = breadcrumbs.filter((b) => !before.has(b.id) && !b.contributor.is_seeded && b.contributor_id !== myContributorId);
      if (arrived.length > 0) {
        say(`New ${arrived[0].kind} tip from ${arrived[0].contributor.display_name}`);
        buzz(20);
        if (open.current.panel === null) setPulsing(true);
      }
    }
    knownIds.current = new Set(breadcrumbs.map((b) => b.id));

    const notes = breadcrumbs.reduce((sum, b) => sum + (b.thanks_notes?.length ?? 0), 0);
    if (knownNotes.current !== null && notes > knownNotes.current) {
      say('Someone thanked your tip');
      buzz(20);
    }
    knownNotes.current = notes;
  }, [breadcrumbs, gym.synced, myContributorId, say]);

  // --- Actions ---------------------------------------------------------------------------
  const guard = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        say(error instanceof ApiFailure ? error.message : 'That did not go through. Please try again.');
      }
    },
    [say],
  );

  const vote = (view: CrumbView, value: VoteValue) => void guard(() => gym.vote(view.crumb.id, value));
  const helped = (view: CrumbView, note?: string) =>
    void guard(async () => {
      await gym.markHelped(view.crumb.id, note);
      say(note ? 'Thank-you sent' : 'Thanks counted');
    });

  const startAdd = () => {
    buzz();
    stopAudio('closed');
    logTabLeft();
    track('add_opened', { from_tab: open.current.tab });
    open.current.panel = 'add';
    setPanel('add');
  };

  const backToList = () => {
    track('add_cancelled', {});
    open.current.panel = 'list';
    if (open.current.tab) open.current.tabAt = Date.now();
    setPanel('list');
  };

  const onPosted = (result: CreateBreadcrumbResponse) => {
    const { breadcrumb } = result;
    onFact('posted');
    open.current.panel = 'list';
    setPanel('list');
    chooseTab(breadcrumb.kind, 'post');
    setPinnedFirstId(breadcrumb.id);
    setHighlightedId(breadcrumb.id);
    say(result.merged ? 'Someone left that tip already. We added your voice to it.' : 'Posted. Everyone can see it now.');
  };

  const askToFinish = () => {
    buzz();
    setConfirming(true);
  };

  const dismissTurnHint = () => {
    buzz();
    saveJson(KEYS.turnHint, session.id);
    setTurnHintGone(true);
  };

  // --- Render ------------------------------------------------------------------------------
  const later = offsetLabel(totalOffset);
  const cameraOff = !camera.on || camera.status === 'denied' || camera.status === 'unavailable';

  const tabs = (
    <div className="tabs" role="tablist" aria-label="Kind of tip">
      {(['text', 'audio'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          role="tab"
          className={`tab${tab === kind ? ' is-on' : ''}`}
          aria-selected={tab === kind}
          onClick={() => (buzz(), chooseTab(kind))}
        >
          {kind === 'text' ? <IconText size={18} /> : <IconMic size={18} />}
          <span>{KIND_LABEL[kind]}</span>
          <b key={counts[kind]} className="tab-count">
            {counts[kind]}
          </b>
        </button>
      ))}
    </div>
  );

  return (
    <main className={`scene${panel ? ' has-panel' : ''}`}>
      {/* ================= Top left: where you are ================= */}
      <div className="hud-tl">
        <span className="tag-chip tag-station">
          <IconPin size={16} />
          <span>{gym.station.name}</span>
        </span>
        {later && (
          <span className="tag-chip tag-later">
            <IconClock size={16} />
            <span>{later}</span>
          </span>
        )}
        {gym.offline && <span className="tag-chip tag-quiet">Offline. Showing saved tips.</span>}
        {cameraOff && (
          <button
            type="button"
            className="tag-chip tag-action"
            onClick={() => {
              buzz();
              setCameraAsked(true);
              onCameraRetry();
            }}
          >
            <IconCamera size={16} />
            <span>
              {cameraAsked && camera.status === 'denied' ? 'Camera blocked. Allow it in your browser settings.' : 'Turn camera on'}
            </span>
          </button>
        )}
        {portrait && !turnHintGone && !panel && (
          <span className="tag-chip tag-turn">
            <IconPhoneTurn size={16} />
            <span>Turn your phone sideways for the glasses view</span>
            <button type="button" className="tag-dismiss" aria-label="Dismiss this hint" onClick={dismissTurnHint}>
              <IconClose size={16} />
            </button>
          </span>
        )}
      </div>

      {/* ================= Right: Breadcrumbs, and the way out ================= */}
      {!panel && (
        <>
          <button
            type="button"
            className={`crumbs-button${pulsing ? ' is-pulsing' : ''}`}
            aria-label={`Breadcrumbs, ${total} ${total === 1 ? 'tip' : 'tips'}`}
            onClick={openPanel}
          >
            <IconLoaf size={26} />
            <span className="crumbs-label">Breadcrumbs</span>
            <b key={total} className="crumbs-count">
              {total}
            </b>
          </button>
          <button type="button" className="btn btn-glass finish-button" onClick={askToFinish}>
            <IconCheck size={18} />
            <span>Finish</span>
          </button>
        </>
      )}

      {toast && (
        <p key={toast} className="toast" role="status">
          {toast}
        </p>
      )}

      {banner && (
        <div className="skip-banner" role="status" aria-live="assertive">
          <div className="skip-card">
            <IconClock size={30} />
            <strong>{banner}</strong>
          </div>
        </div>
      )}

      {panel === 'list' && (
        <Sheet
          title="Breadcrumbs"
          // The two tabs sit where a title would, to leave as much of a short sideways screen as possible for the tips.
          heading={tabs}
          onClose={closePanel}
          toolbar={
            tab && (
              <div className="sheet-tools">
                <TagFilters
                  tag={tag}
                  onTag={(next) => {
                    setTag(next);
                    track('filter_used', { tag: next ?? 'all', tab });
                  }}
                />
              </div>
            )
          }
          footer={
            <button type="button" className="btn btn-primary btn-add" aria-label="Add a breadcrumb" onClick={startAdd}>
              <IconPlus size={20} />
              <span>Add</span>
            </button>
          }
        >
          {tab && list ? (
            <>
              {showLoafHint && (
                <p className="loaf-hint" role="note">
                  <span className="pill pill-loaf">
                    <IconLoaf size={14} />
                    Loaf
                  </span>
                  <span>marks a trusted contributor.</span>
                  <button type="button" className="btn btn-quiet btn-small" onClick={dismissLoafHint}>
                    Got it
                  </button>
                </p>
              )}
              <BreadcrumbList
                list={list}
                kind={tab}
                highlightedId={highlightedId}
                showMore={Boolean(showMore[tab])}
                filtered={tag !== null}
                onShowMore={() => {
                  setShowMore((current) => ({ ...current, [tab]: true }));
                  track('see_more_opened', { tab, more: list.more.length });
                }}
                onVote={vote}
                onHelped={helped}
                onPlayToggle={togglePlay}
                onTranscript={(view, isOpen) => {
                  if (isOpen) track('transcript_opened', {}, view.crumb.id);
                }}
                onNotesSeen={(view) => track('thanks_notes_viewed', { notes: view.crumb.thanks_notes?.length ?? 0 }, view.crumb.id)}
              />
            </>
          ) : (
            <div className="tab-prompt">
              <strong>Breadcrumbs</strong>
              <p>Tips other people left at this station. Pick Text or Audio to see them.</p>
            </div>
          )}
        </Sheet>
      )}

      {panel === 'add' && (
        <Sheet
          title="Add a breadcrumb"
          heading={
            <div className="add-heading">
              <button type="button" className="btn btn-quiet btn-small" onClick={() => (buzz(), backToList())}>
                <IconBack size={16} />
                <span>Tips</span>
              </button>
              <h2>Add a breadcrumb</h2>
            </div>
          }
          onClose={closePanel}
          tall
          keepOpenOnOutsideTap
        >
          <AddBreadcrumb authorName={session.contributor.display_name} onPost={gym.addBreadcrumb} onPosted={onPosted} />
        </Sheet>
      )}

      {confirming && (
        <div className="hud-dialog-wrap">
          <button type="button" className="hud-dialog-scrim" aria-hidden="true" tabIndex={-1} onClick={() => setConfirming(false)} />
          <section className="hud-panel hud-dialog" role="dialog" aria-label="Finish and go to the questions?">
            <h2>Finish and go to the questions?</h2>
            <p className="fine">You will not come back to this view.</p>
            <div className="hud-dialog-actions">
              <button type="button" className="btn btn-quiet" onClick={() => (buzz(), setConfirming(false))}>
                Keep looking
              </button>
              <button type="button" className="btn btn-primary" onClick={() => (buzz(20), onFinish())}>
                <span>Yes, finish</span>
                <IconArrow size={18} />
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
