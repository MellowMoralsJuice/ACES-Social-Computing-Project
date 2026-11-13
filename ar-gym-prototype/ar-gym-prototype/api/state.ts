/**
 * GET  /api/state?session_id=...
 *      The one lightweight session-state endpoint: the virtual clock offset and
 *      the content revision. Phones poll it every 2 seconds when Realtime is unavailable.
 *      It reads one settings row (plus one session row) and nothing else.
 *
 * POST /api/state  { session_id, action: 'scripted_skip' }
 *      The scripted "One week later" moment. The skip belongs to this
 *      phone only (sessions.clock_skip_seconds), so several participants can
 *      each see it at their own pace. The length is fixed on the server.
 */
import { z } from 'zod';
import { SCRIPTED_SKIP_SECONDS } from '../shared/decay.js';
import type { StateResponse } from '../shared/types.js';
import { getDb } from './_lib/db.js';
import { HttpError, rateLimit, route } from './_lib/http.js';
import { getSettings, logEvent, requireSession, uuid } from './_lib/repo.js';

const Body = z.object({ session_id: uuid, action: z.literal('scripted_skip') });

export default route('state', {
  GET: async (ctx) => {
    const db = getDb();
    const settings = await getSettings(db);
    let skip = 0;
    let found = false;
    const rawSession = ctx.query.get('session_id');
    if (rawSession) {
      const id = uuid.parse(rawSession);
      const rows = await db.query('select clock_skip_seconds from sessions where id = $1::uuid', [id]);
      if (rows[0]) {
        found = true;
        skip = Number(rows[0].clock_skip_seconds);
      }
    }
    const response: StateResponse = {
      settings,
      server_now: new Date().toISOString(),
      clock_skip_seconds: skip,
      session_found: found,
    };
    return response;
  },

  POST: async (ctx) => {
    const input = Body.parse(ctx.body);
    const db = getDb();
    const session = await requireSession(db, input.session_id);
    rateLimit(`skip:${session.id}`, 6, 60_000);
    const settings = await getSettings(db);
    if (!settings.auto_skip_enabled) {
      throw new HttpError(409, 'skip_disabled', 'The scripted time-skip is turned off.');
    }
    if (session.clock_skip_seconds === 0) {
      await db.query('update sessions set clock_skip_seconds = $2 where id = $1::uuid', [session.id, SCRIPTED_SKIP_SECONDS]);
      await logEvent(db, session.id, 'time_skip_seen', null, { seconds: SCRIPTED_SKIP_SECONDS, source: 'scripted' });
    }
    return { clock_skip_seconds: SCRIPTED_SKIP_SECONDS };
  },
});
