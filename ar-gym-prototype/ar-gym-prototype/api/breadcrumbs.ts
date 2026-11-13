/**
 * GET  /api/breadcrumbs?station=CODE&session_id=...&kind=text&limit=50
 *      Breadcrumbs for a station, best first within each kind (the Text tab and
 *      the Audio tab), using an indexed ORDER BY rank_score LIMIT n.
 * POST /api/breadcrumbs  { session_id, station, kind, body?, tags?, audio? }
 *      Anyone can add a tip. Three shapes:
 *        kind "text"                      a typed tip (3 to 140 characters)
 *        kind "audio" + audio {data,...}  a recording (base64, 20 s and 1 MB at most)
 *        kind "audio" and no audio        "Type it and I will read it aloud":
 *                                         the text is saved and phones speak it
 *      A typed tip that matches an existing one of the same kind (same
 *      normalized-text hash) is merged into it instead of creating a duplicate.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyInteraction, freshnessAt } from '../shared/decay.js';
import { AUDIO_MAX_SECONDS, TAG_KEYS, TIP_MAX_LENGTH, TIP_MIN_LENGTH, cleanTipText, tipHash } from '../shared/text.js';
import type { Breadcrumb, BreadcrumbKind, BreadcrumbsResponse, CreateBreadcrumbResponse } from '../shared/types.js';
import { readClip, storeClip } from './_lib/audio.js';
import { getDb } from './_lib/db.js';
import { HttpError, rateLimit, route } from './_lib/http.js';
import { broadcastChange } from './_lib/realtime.js';
import {
  bumpContentRev,
  clockFor,
  getBreadcrumb,
  getSettings,
  getStationByCode,
  listBreadcrumbs,
  lockBreadcrumb,
  logEvent,
  rankOf,
  requireSession,
  uuid,
} from './_lib/repo.js';

const Code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
const KINDS: BreadcrumbKind[] = ['text', 'audio'];
const KindParam = z.enum(['text', 'audio']);
const MAX_LIMIT = 50;
const MAX_TIPS_PER_SESSION = 12;
const MAX_RECORDINGS_PER_SESSION = 5;
// A 1 MB clip is about 1.4 MB once it is base64 inside JSON.
const MAX_BODY_BYTES = 1_600_000;

const Create = z.object({
  session_id: uuid,
  station: Code,
  kind: KindParam,
  body: z.string().max(400).optional().default(''),
  tags: z.array(z.string().max(32)).max(4).optional().default([]),
  audio: z
    .object({
      data: z.string().min(1).max(1_500_000),
      mime: z.string().min(1).max(80),
      seconds: z
        .number()
        .positive()
        .max(AUDIO_MAX_SECONDS + 2),
    })
    .optional(),
});

export default route(
  'breadcrumbs',
  {
    GET: async (ctx) => {
      const db = getDb();
      const station = await getStationByCode(db, Code.parse(ctx.query.get('station') ?? ''));
      const rawSession = ctx.query.get('session_id');
      const sessionId = rawSession ? uuid.parse(rawSession) : null;
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .parse(ctx.query.get('limit') ?? MAX_LIMIT);
      const kindParam = ctx.query.get('kind');
      const kinds = kindParam ? [KindParam.parse(kindParam)] : KINDS;

      const breadcrumbs: Breadcrumb[] = [];
      for (const kind of kinds) {
        breadcrumbs.push(...(await listBreadcrumbs(db, station.id, sessionId, kind, limit)));
      }
      const settings = await getSettings(db);
      const response: BreadcrumbsResponse = { breadcrumbs, content_rev: settings.content_rev };
      return response;
    },

    POST: async (ctx) => {
      const input = Create.parse(ctx.body);
      const db = getDb();
      const session = await requireSession(db, input.session_id);
      rateLimit(`crumb:${session.id}`, 6, 60_000);
      if (session.baseline_mode) throw new HttpError(403, 'baseline', 'This is off in this version.');

      const station = await getStationByCode(db, input.station);
      const tags = input.tags.filter((tag) => TAG_KEYS.includes(tag));
      if (input.audio && input.kind !== 'audio') throw new HttpError(400, 'kind_mismatch', 'A recording has to be an audio tip.');
      const recorded = input.kind === 'audio' && input.audio !== undefined;
      // A recording speaks for itself; a typed tip (shown or read aloud) needs its words.
      const body = recorded ? '' : cleanTipText(input.body);
      if (!recorded) {
        if (body.length < TIP_MIN_LENGTH) throw new HttpError(400, 'too_short', 'Add a few words so your tip is useful.');
        if (body.length > TIP_MAX_LENGTH) {
          throw new HttpError(400, 'too_long', `Keep tips under ${TIP_MAX_LENGTH} characters so they stay glanceable.`);
        }
      }
      // Check the clip (type, real file header, size) before touching the database.
      const clip = input.audio ? readClip(input.audio.data, input.audio.mime) : null;
      if (clip) rateLimit(`clip:${session.id}`, 3, 60_000);
      const newId = randomUUID();
      const shape = recorded ? 'recorded' : input.kind === 'audio' ? 'read_aloud' : 'typed';

      const result = await db.tx(async (tx): Promise<{ id: string; merged: boolean }> => {
        const settings = await getSettings(tx);
        const clock = clockFor(settings, session.clock_skip_seconds);
        const contributorRows = await tx.query('select id from contributors where session_id = $1::uuid', [session.id]);
        if (!contributorRows[0]) throw new HttpError(403, 'no_guest', 'Start a new session to leave breadcrumbs.');
        const contributorId = String(contributorRows[0].id);

        const mine = await tx.query('select count(*)::int as n from breadcrumbs where contributor_id = $1::uuid', [contributorId]);
        if (Number(mine[0].n) >= MAX_TIPS_PER_SESSION) {
          throw new HttpError(429, 'tip_limit', 'That is plenty of breadcrumbs for one session. Thank you!');
        }

        if (clip) {
          const clips = await tx.query(
            'select count(*)::int as n from breadcrumbs where contributor_id = $1::uuid and audio_url is not null',
            [contributorId],
          );
          if (Number(clips[0].n) >= MAX_RECORDINGS_PER_SESSION) {
            throw new HttpError(429, 'clip_limit', 'That is plenty of recordings for one session. Thank you!');
          }
        }

        // Near-duplicate merge: one indexed lookup on (station, kind, normalized-text hash).
        // Recordings are never merged: two voices are two tips.
        const hash = recorded ? tipHash(newId) : tipHash(body);
        const existing = recorded
          ? []
          : await tx.query(
              `select id from breadcrumbs where station_id = $1::uuid and kind = $2 and text_hash = $3
              order by rank_score desc limit 1`,
              [station.id, input.kind, hash],
            );
        if (existing[0]) {
          const id = String(existing[0].id);
          await lockBreadcrumb(tx, id);
          const current = await getBreadcrumb(tx, id, session.id);
          // "N people left this tip" counts people: the author, or someone who already echoed it, adds nothing.
          const already = await tx.query(
            `select 1 from behavior_events
            where session_id = $1::uuid and breadcrumb_id = $2::uuid and event_type = 'breadcrumb_added' limit 1`,
            [session.id, id],
          );
          if (already[0] || current.contributor_id === contributorId) return { id, merged: true };
          const next = applyInteraction(current, 'duplicate', clock);
          const updated = { ...current, ...next };
          await tx.query(
            `update breadcrumbs set duplicate_count = duplicate_count + 1, base_freshness = $2,
               last_interaction_at = ($3::text)::timestamptz, rank_score = $4
            where id = $1::uuid`,
            [id, next.base_freshness, next.last_interaction_at, rankOf(updated, freshnessAt(updated, clock))],
          );
          await logEvent(tx, session.id, 'breadcrumb_added', id, { kind: input.kind, shape, merged: true });
          await bumpContentRev(tx);
          return { id, merged: true };
        }

        const createdAt = new Date(clock.nowMs).toISOString();
        const audioUrl = clip ? await storeClip(tx, newId, clip.mime, clip.bytes) : null;
        const seconds = clip && input.audio ? Math.min(AUDIO_MAX_SECONDS, Math.round(input.audio.seconds * 10) / 10) : null;
        const rows = await tx.query(
          `insert into breadcrumbs (id, station_id, kind, body, contributor_id, base_freshness,
             last_interaction_at, created_at, rank_score, tags, text_hash, audio_url, audio_seconds)
         values ($8::uuid, $1::uuid, $2, $3, $4::uuid, 100, ($5::text)::timestamptz, ($5::text)::timestamptz, 100,
             array(select jsonb_array_elements_text(($6::text)::jsonb)), $7, $9, $10)
         returning id`,
          [station.id, input.kind, body, contributorId, createdAt, JSON.stringify(tags), hash, newId, audioUrl, seconds],
        );
        const id = String(rows[0].id);
        await logEvent(tx, session.id, 'breadcrumb_added', id, { kind: input.kind, shape, merged: false });
        await bumpContentRev(tx);
        return { id, merged: false };
      });

      await broadcastChange('content');
      const response: CreateBreadcrumbResponse = {
        breadcrumb: await getBreadcrumb(db, result.id, session.id),
        merged: result.merged,
      };
      return response;
    },
  },
  { maxBodyBytes: MAX_BODY_BYTES },
);
