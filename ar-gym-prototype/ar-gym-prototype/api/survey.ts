/**
 * POST /api/survey  { session_id, answers: [{ key, answer }], final? }
 *
 * One row per answer in survey_responses. The group tag and prototype version are not
 * sent by the client: they live on the session row and are joined in at
 * export time. Answers are saved as the participant goes, so a half-finished
 * survey is not lost; `final: true` marks the session complete.
 */
import { z } from 'zod';
import { SURVEY_ANSWER_MAX_LENGTH, SURVEY_KEYS, isValidAnswer } from '../shared/survey.js';
import { cleanTipText } from '../shared/text.js';
import { getDb } from './_lib/db.js';
import { HttpError, rateLimit, route } from './_lib/http.js';
import { broadcastChange } from './_lib/realtime.js';
import { logEvent, requireSession, uuid } from './_lib/repo.js';

const Body = z.object({
  session_id: uuid,
  answers: z.array(z.object({ key: z.string().max(64), answer: z.union([z.string(), z.number()]) })).max(SURVEY_KEYS.length),
  final: z.boolean().optional().default(false),
});

export default route('survey', {
  POST: async (ctx) => {
    const input = Body.parse(ctx.body);
    const db = getDb();
    const session = await requireSession(db, input.session_id);
    rateLimit(`survey:${session.id}`, 120, 60_000);

    const rows: Array<{ key: string; answer: string }> = [];
    for (const item of input.answers) {
      const answer = cleanTipText(String(item.answer)).slice(0, SURVEY_ANSWER_MAX_LENGTH);
      if (!SURVEY_KEYS.includes(item.key)) throw new HttpError(400, 'unknown_question', 'Unknown survey question.');
      if (!answer) continue; // skipped free-text
      if (!isValidAnswer(item.key, answer)) throw new HttpError(400, 'invalid_answer', 'That answer is not valid.');
      rows.push({ key: item.key, answer });
    }

    await db.tx(async (tx) => {
      for (const row of rows) {
        await tx.query(
          `insert into survey_responses (session_id, question_key, answer) values ($1::uuid, $2, $3)
           on conflict (session_id, question_key) do update set answer = excluded.answer, created_at = now()`,
          [session.id, row.key, row.answer],
        );
      }
      if (input.final) {
        const done = await tx.query('update sessions set completed_at = now() where id = $1::uuid and completed_at is null returning id', [
          session.id,
        ]);
        if (done[0]) await logEvent(tx, session.id, 'survey_submitted', null, {});
      }
    });
    if (input.final) await broadcastChange('state');
    return { saved: rows.length, final: input.final };
  },
});
