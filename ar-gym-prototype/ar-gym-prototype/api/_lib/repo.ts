/**
 * Shared queries and row mappers used by several routes.
 */
import { z } from 'zod';
import { rankScore, virtualNowMs, type DecayClock } from '../../shared/decay.js';
import type { Breadcrumb, BreadcrumbKind, Contributor, PinState, SessionInfo, Settings, VoteValue } from '../../shared/types.js';
import type { Db, Row } from './db.js';
import { HttpError } from './http.js';

export const uuid = z.uuid();

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.query('select * from settings where id = true');
  const r = rows[0];
  if (!r) throw new HttpError(503, 'not_seeded', 'The database has not been set up yet. Run "npm run db:setup".');
  return {
    virtual_clock_offset_seconds: Number(r.virtual_clock_offset_seconds),
    gym_busyness: r.gym_busyness as Settings['gym_busyness'],
    decay_multiplier: Number(r.decay_multiplier),
    auto_skip_enabled: Boolean(r.auto_skip_enabled),
    session_epoch: Number(r.session_epoch),
    survey_nonce: Number(r.survey_nonce),
    survey_session_id: (r.survey_session_id as string | null) ?? null,
    prototype_version: r.prototype_version as Settings['prototype_version'],
    content_rev: Number(r.content_rev),
  };
}

/** The decay clock for one request: real time + global offset + this phone's scripted skip. */
export function clockFor(settings: Settings, sessionSkipSeconds = 0, realNowMs = Date.now()): DecayClock {
  return {
    nowMs: virtualNowMs(realNowMs, settings.virtual_clock_offset_seconds, sessionSkipSeconds),
    busyness: settings.gym_busyness,
    multiplier: settings.decay_multiplier,
    skipActive: settings.virtual_clock_offset_seconds + sessionSkipSeconds > 0,
  };
}

export interface SessionRow {
  id: string;
  /** Optional tag from the participant's link (?group=novice). */
  group: string | null;
  prototype_version: SessionInfo['prototype_version'];
  baseline_mode: boolean;
  created_at: string;
  clock_skip_seconds: number;
}

/** Look the participant up. Everything known about them comes from this row, never from the client. */
export async function requireSession(db: Db, sessionId: unknown): Promise<SessionRow> {
  const id = uuid.parse(sessionId);
  const rows = await db.query('select * from sessions where id = $1::uuid', [id]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'session_not_found', 'This session has ended. Tap Start to begin again.');
  return {
    id: String(r.id),
    group: (r.group_tag as string | null) ?? null,
    prototype_version: r.prototype_version as SessionInfo['prototype_version'],
    baseline_mode: Boolean(r.baseline_mode),
    created_at: iso(r.created_at),
    clock_skip_seconds: Number(r.clock_skip_seconds),
  };
}

/**
 * $2 is the participant looking (or null). Thank-you notes are returned only to
 * the participant who wrote the tip: `c.session_id = $2` is checked in SQL, so no
 * client can ask for someone else's notes.
 */
const BREADCRUMB_SELECT = `
  select b.*,
         c.display_name as c_display_name, c.has_loaf_badge as c_has_loaf_badge, c.is_seeded as c_is_seeded,
         v.value as my_vote, (h.id is not null) as my_helped, h.note as my_note,
         case when c.session_id = $2::uuid then
           (select coalesce(jsonb_agg(n.note order by n.created_at desc), '[]'::jsonb)
              from helped_marks n where n.breadcrumb_id = b.id and n.note is not null)
         end as thanks_notes
    from breadcrumbs b
    join contributors c on c.id = b.contributor_id
    left join votes v on v.breadcrumb_id = b.id and v.session_id = $2::uuid
    left join helped_marks h on h.breadcrumb_id = b.id and h.session_id = $2::uuid`;

function notesOf(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

export function mapBreadcrumb(r: Row): Breadcrumb {
  const contributor: Contributor = {
    id: String(r.contributor_id),
    display_name: String(r.c_display_name),
    has_loaf_badge: Boolean(r.c_has_loaf_badge),
    is_seeded: Boolean(r.c_is_seeded),
  };
  return {
    id: String(r.id),
    station_id: String(r.station_id),
    kind: r.kind as BreadcrumbKind,
    body: String(r.body),
    audio_url: (r.audio_url as string | null) ?? null,
    audio_seconds: r.audio_seconds === null || r.audio_seconds === undefined ? null : Number(r.audio_seconds),
    contributor_id: contributor.id,
    base_freshness: Number(r.base_freshness),
    last_interaction_at: iso(r.last_interaction_at),
    created_at: iso(r.created_at),
    is_verified: Boolean(r.is_verified),
    is_flagged: Boolean(r.is_flagged),
    helped_count: Number(r.helped_count),
    useful_count: Number(r.useful_count),
    not_useful_count: Number(r.not_useful_count),
    rank_score: Number(r.rank_score),
    tags: (r.tags as string[] | null) ?? [],
    text_hash: String(r.text_hash),
    pin_state: r.pin_state as PinState,
    duplicate_count: Number(r.duplicate_count),
    contributor,
    my_vote: (r.my_vote as VoteValue | null) ?? null,
    my_helped: Boolean(r.my_helped),
    my_note: (r.my_note as string | null) ?? null,
    thanks_notes: notesOf(r.thanks_notes),
  };
}

/**
 * The best `limit` breadcrumbs of one kind (the Text tab or the Audio tab), best first. Served
 * straight from the (station_id, kind, rank_score desc) index with LIMIT — no in-memory sort.
 */
export async function listBreadcrumbs(
  db: Db,
  stationId: string,
  sessionId: string | null,
  kind: BreadcrumbKind,
  limit: number,
): Promise<Breadcrumb[]> {
  const rows = await db.query(
    `${BREADCRUMB_SELECT}
      where b.station_id = $1::uuid and b.kind = $3
      order by b.rank_score desc
      limit $4`,
    [stationId, sessionId, kind, limit],
  );
  return rows.map(mapBreadcrumb);
}

export async function getBreadcrumb(db: Db, id: string, sessionId: string | null): Promise<Breadcrumb> {
  const rows = await db.query(`${BREADCRUMB_SELECT} where b.id = $1::uuid`, [id, sessionId]);
  if (!rows[0]) throw new HttpError(404, 'breadcrumb_not_found', 'That tip is no longer here.');
  return mapBreadcrumb(rows[0]);
}

/** Lock one breadcrumb row for the duration of the transaction (serializes votes on it). */
export async function lockBreadcrumb(db: Db, id: string): Promise<void> {
  const rows = await db.query('select id from breadcrumbs where id = $1::uuid for update', [id]);
  if (!rows[0]) throw new HttpError(404, 'breadcrumb_not_found', 'That tip is no longer here.');
}

/** Recompute the stored rank for a breadcrumb from its (already updated) fields. */
export function rankOf(b: Breadcrumb, freshness: number): number {
  return rankScore(
    {
      useful_count: b.useful_count,
      not_useful_count: b.not_useful_count,
      helped_count: b.helped_count,
      is_verified: b.is_verified,
      is_flagged: b.is_flagged,
      has_loaf_badge: b.contributor.has_loaf_badge,
    },
    freshness,
  );
}

/** Tell every phone the breadcrumb list changed. One O(1) update on the settings row. */
export async function bumpContentRev(db: Db): Promise<void> {
  await db.query('update settings set content_rev = content_rev + 1, updated_at = now() where id = true');
}

export async function logEvent(
  db: Db,
  sessionId: string,
  eventType: string,
  breadcrumbId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into behavior_events (session_id, event_type, breadcrumb_id, metadata)
     values ($1::uuid, $2, $3::uuid, ($4::text)::jsonb)`,
    [sessionId, eventType, breadcrumbId, JSON.stringify(metadata)],
  );
}

export async function getStationByCode(db: Db, code: string): Promise<{ id: string; name: string; code: string }> {
  const rows = await db.query('select id, name, code from stations where code = $1', [code]);
  if (!rows[0]) throw new HttpError(404, 'station_not_found', 'We could not find that station.');
  return { id: String(rows[0].id), name: String(rows[0].name), code: String(rows[0].code) };
}
