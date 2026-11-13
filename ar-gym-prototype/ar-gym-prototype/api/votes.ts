/**
 * POST /api/votes  { session_id, breadcrumb_id, value: 'useful' | 'not_useful' }
 *
 * Idempotent: one vote per participant per breadcrumb, backed by the unique
 * constraint on votes (breadcrumb_id, session_id). Voting the same value again
 * changes nothing; voting the other value switches the vote.
 *
 * A vote re-bases the breadcrumb's freshness (current value + delta, clock
 * restarted) and refreshes the stored rank_score, all in one transaction.
 */
import { z } from 'zod';
import { applyInteraction, freshnessAt } from '../shared/decay.js';
import { getDb } from './_lib/db.js';
import { HttpError, rateLimit, route } from './_lib/http.js';
import { broadcastChange } from './_lib/realtime.js';
import {
  bumpContentRev,
  clockFor,
  getBreadcrumb,
  getSettings,
  lockBreadcrumb,
  logEvent,
  rankOf,
  requireSession,
  uuid,
} from './_lib/repo.js';

const Body = z.object({
  session_id: uuid,
  breadcrumb_id: uuid,
  value: z.enum(['useful', 'not_useful']),
});

export default route('votes', {
  POST: async (ctx) => {
    const input = Body.parse(ctx.body);
    const db = getDb();
    const session = await requireSession(db, input.session_id);
    rateLimit(`vote:${session.id}`, 40, 60_000);
    if (session.baseline_mode) throw new HttpError(403, 'baseline', 'Voting is off in this version.');

    const changed = await db.tx(async (tx) => {
      await lockBreadcrumb(tx, input.breadcrumb_id);
      const current = await getBreadcrumb(tx, input.breadcrumb_id, session.id);
      if (current.my_vote === input.value) return false; // already counted

      const settings = await getSettings(tx);
      const clock = clockFor(settings, session.clock_skip_seconds);
      await tx.query(
        `insert into votes (breadcrumb_id, session_id, value) values ($1::uuid, $2::uuid, $3)
         on conflict (breadcrumb_id, session_id) do update set value = excluded.value, created_at = now()`,
        [current.id, session.id, input.value],
      );

      const updated = {
        ...current,
        ...applyInteraction(current, input.value, clock),
        useful_count: current.useful_count + (input.value === 'useful' ? 1 : 0) - (current.my_vote === 'useful' ? 1 : 0),
        not_useful_count: current.not_useful_count + (input.value === 'not_useful' ? 1 : 0) - (current.my_vote === 'not_useful' ? 1 : 0),
      };
      await tx.query(
        `update breadcrumbs set useful_count = $2, not_useful_count = $3, base_freshness = $4,
             last_interaction_at = ($5::text)::timestamptz, rank_score = $6
          where id = $1::uuid`,
        [
          current.id,
          updated.useful_count,
          updated.not_useful_count,
          updated.base_freshness,
          updated.last_interaction_at,
          rankOf(updated, freshnessAt(updated, clock)),
        ],
      );
      await logEvent(tx, session.id, 'vote_cast', current.id, {
        value: input.value,
        changed_from: current.my_vote,
        kind: current.kind,
        loaf: current.contributor.has_loaf_badge,
        flagged: current.is_flagged,
        verified: current.is_verified,
      });
      await bumpContentRev(tx);
      return true;
    });

    if (changed) await broadcastChange('content');
    return { breadcrumb: await getBreadcrumb(db, input.breadcrumb_id, session.id), changed };
  },
});
