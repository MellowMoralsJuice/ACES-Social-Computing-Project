/**
 * POST /api/helped  { session_id, breadcrumb_id, note? } — the "Helped me" button.
 *
 * One thanks per participant per breadcrumb (unique constraint), so tapping
 * twice counts once. An optional short thank-you note (80 characters at most)
 * can be sent with the first tap or added afterwards; it can be set once.
 * Notes are shown only to the participant who wrote the tip. Nobody can thank their own tip.
 */
import { z } from 'zod';
import { applyInteraction, freshnessAt } from '../shared/decay.js';
import { THANKS_MAX_LENGTH, cleanTipText } from '../shared/text.js';
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

const Body = z.object({ session_id: uuid, breadcrumb_id: uuid, note: z.string().max(400).optional() });

export default route('helped', {
  POST: async (ctx) => {
    const input = Body.parse(ctx.body);
    const db = getDb();
    const session = await requireSession(db, input.session_id);
    rateLimit(`helped:${session.id}`, 40, 60_000);
    if (session.baseline_mode) throw new HttpError(403, 'baseline', 'This is off in this version.');

    const note = cleanTipText(input.note ?? '');
    if (note.length > THANKS_MAX_LENGTH) {
      throw new HttpError(400, 'note_too_long', `Keep the note under ${THANKS_MAX_LENGTH} characters.`);
    }

    const changed = await db.tx(async (tx) => {
      await lockBreadcrumb(tx, input.breadcrumb_id);
      const own = await tx.query(
        `select 1 from breadcrumbs b join contributors c on c.id = b.contributor_id
          where b.id = $1::uuid and c.session_id = $2::uuid`,
        [input.breadcrumb_id, session.id],
      );
      if (own[0]) throw new HttpError(403, 'own_tip', 'That one is yours.');
      const inserted = await tx.query(
        `insert into helped_marks (breadcrumb_id, session_id, note) values ($1::uuid, $2::uuid, $3)
         on conflict (breadcrumb_id, session_id) do nothing returning id`,
        [input.breadcrumb_id, session.id, note || null],
      );
      if (!inserted[0]) {
        // Already thanked: the count does not move. A note can still be added, once.
        if (!note) return false;
        const added = await tx.query(
          `update helped_marks set note = $3
            where breadcrumb_id = $1::uuid and session_id = $2::uuid and note is null returning id`,
          [input.breadcrumb_id, session.id, note],
        );
        if (!added[0]) return false;
        const crumb = await getBreadcrumb(tx, input.breadcrumb_id, session.id);
        await logEvent(tx, session.id, 'thanks_note_sent', crumb.id, { kind: crumb.kind, length: note.length });
        await bumpContentRev(tx);
        return true;
      }

      const current = await getBreadcrumb(tx, input.breadcrumb_id, session.id);
      const settings = await getSettings(tx);
      const clock = clockFor(settings, session.clock_skip_seconds);
      const updated = {
        ...current,
        ...applyInteraction(current, 'helped', clock),
        helped_count: current.helped_count + 1,
      };
      await tx.query(
        `update breadcrumbs set helped_count = $2, base_freshness = $3,
             last_interaction_at = ($4::text)::timestamptz, rank_score = $5
          where id = $1::uuid`,
        [
          current.id,
          updated.helped_count,
          updated.base_freshness,
          updated.last_interaction_at,
          rankOf(updated, freshnessAt(updated, clock)),
        ],
      );
      await logEvent(tx, session.id, 'helped_marked', current.id, {
        kind: current.kind,
        loaf: current.contributor.has_loaf_badge,
        flagged: current.is_flagged,
        verified: current.is_verified,
      });
      if (note) await logEvent(tx, session.id, 'thanks_note_sent', current.id, { kind: current.kind, length: note.length });
      await bumpContentRev(tx);
      return true;
    });

    if (changed) await broadcastChange('content');
    return { breadcrumb: await getBreadcrumb(db, input.breadcrumb_id, session.id), changed };
  },
});
