/**
 * POST /api/sessions  { group?, baseline? } — start an anonymous participant session.
 *
 * No names, no contact info, no roles. Everyone can read, vote, thank and add,
 * and everyone gets a friendly made-up name ("Guest 4") to post under.
 * `group` is an optional tag carried by the link (?group=novice) so the team
 * can split the room without any picker in the app.
 */
import { z } from 'zod';
import type { Contributor, SessionInfo } from '../shared/types.js';
import { getDb } from './_lib/db.js';
import { rateLimit, route } from './_lib/http.js';
import { getSettings, logEvent } from './_lib/repo.js';

const Body = z.object({
  group: z
    .string()
    .regex(/^[a-z0-9_-]{1,24}$/)
    .nullable()
    .optional(),
  baseline: z.boolean().optional().default(false),
});

export default route('sessions', {
  POST: async (ctx) => {
    const input = Body.parse(ctx.body);
    // A whole class can share one public IP, so this only stops a runaway loop.
    rateLimit(`session:${ctx.ip}`, 120, 60_000);
    const db = getDb();
    return db.tx(async (tx): Promise<SessionInfo> => {
      const settings = await getSettings(tx);
      // Was the app already being steered by hand when this participant started?
      const pinned = await tx.query("select 1 from breadcrumbs where pin_state <> 'none' limit 1");
      const overrideActive = settings.virtual_clock_offset_seconds > 0 || pinned.length > 0;
      const group = input.group ?? null;

      const rows = await tx.query(
        `insert into sessions (group_tag, prototype_version, baseline_mode, override_active)
         values ($1, $2, $3, $4) returning id, created_at`,
        [group, settings.prototype_version, input.baseline, overrideActive],
      );
      const id = String(rows[0].id);

      // A made-up name, so tips never carry a real identity.
      const created = await tx.query(
        `insert into contributors (display_name, session_id)
         values ('Guest ' || nextval('guest_number_seq'), $1::uuid) returning id, display_name`,
        [id],
      );
      const contributor: Contributor = {
        id: String(created[0].id),
        display_name: String(created[0].display_name),
        has_loaf_badge: false,
        is_seeded: false,
      };

      await logEvent(tx, id, 'session_started', null, { group, baseline: input.baseline, override_active: overrideActive });

      return {
        id,
        group,
        prototype_version: settings.prototype_version,
        baseline_mode: input.baseline,
        created_at: new Date(rows[0].created_at as string).toISOString(),
        clock_skip_seconds: 0,
        contributor,
      };
    });
  },
});
