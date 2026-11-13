/**
 * GET  /api/admin/actions — everything the admin panel shows: settings, every
 *      breadcrumb, recent participant sessions, and the action log.
 * POST /api/admin/actions  { type, ...payload } — perform one override.
 *
 * Every POST is written to admin_actions with a timestamp, so the team can
 * later tell hand-steered moments from automatic ones. Actions that steer the
 * participant's experience (time-skip, pins, the Loaf badge) also flag every
 * session currently in progress.
 */
import { z } from 'zod';
import { TIME_SKIPS, freshnessAt } from '../../shared/decay.js';
import type { AdminActionRow, AdminOverview, AdminSessionRow, Breadcrumb } from '../../shared/types.js';
import { requireAdmin } from '../_lib/auth.js';
import { getDb, type Db } from '../_lib/db.js';
import { HttpError, route } from '../_lib/http.js';
import { broadcastChange } from '../_lib/realtime.js';
import { clockFor, getBreadcrumb, getSettings, mapBreadcrumb, rankOf, uuid } from '../_lib/repo.js';
import { applySeed } from '../_lib/seed.js';

const skipSeconds = TIME_SKIPS.map((skip) => skip.seconds) as number[];

const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('time_skip'), seconds: z.number().refine((n) => skipSeconds.includes(n), 'Unknown skip') }),
  z.object({ type: z.literal('reset_time') }),
  z.object({ type: z.literal('set_pin'), breadcrumb_id: uuid, pin_state: z.enum(['none', 'keep_fresh', 'force_stale']) }),
  z.object({ type: z.literal('set_loaf'), contributor_id: uuid, value: z.boolean() }),
  z.object({ type: z.literal('set_auto_skip'), value: z.boolean() }),
  z.object({ type: z.literal('set_prototype_version'), version: z.enum(['session_1', 'session_2']) }),
  z.object({ type: z.literal('start_survey'), session_id: uuid.nullable() }),
  z.object({ type: z.literal('new_participant') }),
  z.object({ type: z.literal('clear_added') }),
]);
type ActionInput = z.infer<typeof Action>;

/** Actions that mean "a human steered what the participant saw". */
const STEERING = new Set<ActionInput['type']>(['time_skip', 'set_pin', 'set_loaf']);

async function touchSettings(db: Db, sql: string, params: unknown[] = []): Promise<void> {
  await db.query(`update settings set ${sql}, updated_at = now() where id = true`, params);
}

/** Refresh the stored rank of one breadcrumb after an admin changes a ranking input. */
async function refreshRank(db: Db, id: string): Promise<void> {
  const settings = await getSettings(db);
  const crumb = await getBreadcrumb(db, id, null);
  const rank = rankOf(crumb, freshnessAt(crumb, clockFor(settings)));
  await db.query('update breadcrumbs set rank_score = $2 where id = $1::uuid', [id, rank]);
}

async function perform(db: Db, action: ActionInput): Promise<'state' | 'content'> {
  switch (action.type) {
    case 'time_skip':
      // The whole time-skip: shift ONE number. No breadcrumb row is rewritten.
      await touchSettings(db, 'virtual_clock_offset_seconds = least(virtual_clock_offset_seconds + $1, 315360000)', [action.seconds]);
      return 'state';
    case 'reset_time':
      await touchSettings(db, 'virtual_clock_offset_seconds = 0');
      await db.query('update sessions set clock_skip_seconds = 0 where completed_at is null');
      await applySeed(db, { restore: true });
      return 'content';
    case 'set_pin':
      // Stored as a state and applied inside the read-time decay calculation; freshness is not rewritten.
      await db.query('update breadcrumbs set pin_state = $2 where id = $1::uuid', [action.breadcrumb_id, action.pin_state]);
      await touchSettings(db, 'content_rev = content_rev + 1');
      return 'content';
    case 'set_loaf': {
      await db.query('update contributors set has_loaf_badge = $2 where id = $1::uuid', [action.contributor_id, action.value]);
      const crumbs = await db.query('select id from breadcrumbs where contributor_id = $1::uuid', [action.contributor_id]);
      for (const row of crumbs) await refreshRank(db, String(row.id));
      await touchSettings(db, 'content_rev = content_rev + 1');
      return 'content';
    }
    case 'set_auto_skip':
      await touchSettings(db, 'auto_skip_enabled = $1', [action.value]);
      return 'state';
    case 'set_prototype_version':
      await touchSettings(db, 'prototype_version = $1', [action.version]);
      return 'state';
    case 'start_survey':
      await touchSettings(db, 'survey_nonce = survey_nonce + 1, survey_session_id = $1::uuid', [action.session_id]);
      return 'state';
    case 'new_participant':
      // Session reset: every phone returns to the welcome screen.
      await touchSettings(db, 'session_epoch = session_epoch + 1, survey_session_id = null');
      return 'state';
    case 'clear_added':
      await db.query('delete from breadcrumbs where not is_seeded');
      // Recordings kept in the database go with their tips. (Clips in a Supabase Storage bucket are left there.)
      await db.query('delete from audio_clips');
      await touchSettings(db, 'content_rev = content_rev + 1');
      return 'content';
    default: {
      const never: never = action;
      throw new HttpError(400, 'unknown_action', `Unknown action ${JSON.stringify(never)}`);
    }
  }
}

async function overview(db: Db): Promise<AdminOverview> {
  const settings = await getSettings(db);
  const crumbRows = await db.query(
    `select b.*, c.display_name as c_display_name, c.has_loaf_badge as c_has_loaf_badge, c.is_seeded as c_is_seeded,
            null as my_vote, false as my_helped, null as my_note,
            (select coalesce(jsonb_agg(n.note order by n.created_at desc), '[]'::jsonb)
               from helped_marks n where n.breadcrumb_id = b.id and n.note is not null) as thanks_notes
       from breadcrumbs b join contributors c on c.id = b.contributor_id
      order by b.kind desc, b.rank_score desc limit 200`,
  );
  const breadcrumbs: Breadcrumb[] = crumbRows.map(mapBreadcrumb);
  const sessionRows = await db.query(
    `select s.id, s.group_tag, (select c.display_name from contributors c where c.session_id = s.id) as guest_name, s.prototype_version, s.baseline_mode, s.created_at, s.completed_at, s.override_active,
            (select count(*)::int from survey_responses r where r.session_id = s.id) as answers
       from sessions s order by s.created_at desc limit 30`,
  );
  const sessions: AdminSessionRow[] = sessionRows.map((r) => ({
    id: String(r.id),
    group: (r.group_tag as string | null) ?? null,
    guest_name: (r.guest_name as string | null) ?? null,
    prototype_version: r.prototype_version as AdminSessionRow['prototype_version'],
    baseline_mode: Boolean(r.baseline_mode),
    created_at: new Date(r.created_at as string).toISOString(),
    completed_at: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
    override_active: Boolean(r.override_active),
    answers: Number(r.answers),
  }));
  const actionRows = await db.query('select id, action_type, payload, created_at from admin_actions order by created_at desc limit 60');
  const actions: AdminActionRow[] = actionRows.map((r) => ({
    id: String(r.id),
    action_type: String(r.action_type),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    created_at: new Date(r.created_at as string).toISOString(),
  }));
  return { settings, server_now: new Date().toISOString(), breadcrumbs, sessions, actions };
}

export default route('admin-actions', {
  GET: async (ctx) => {
    requireAdmin(ctx);
    return overview(getDb());
  },

  POST: async (ctx) => {
    requireAdmin(ctx);
    const action = Action.parse(ctx.body);
    const db = getDb();
    const kind = await db.tx(async (tx) => {
      const changed = await perform(tx, action);
      const { type, ...payload } = action;
      await tx.query('insert into admin_actions (action_type, payload) values ($1, ($2::text)::jsonb)', [type, JSON.stringify(payload)]);
      const releasesOverride = type === 'set_pin' && action.pin_state === 'none';
      if (STEERING.has(type) && !releasesOverride) {
        // Flag every session still in progress so it can be excluded or noted in the results.
        await tx.query(
          `update sessions set override_active = true
            where completed_at is null and created_at > now() - interval '90 minutes'`,
        );
      }
      return changed;
    });
    await broadcastChange(kind);
    return overview(db);
  },
});
