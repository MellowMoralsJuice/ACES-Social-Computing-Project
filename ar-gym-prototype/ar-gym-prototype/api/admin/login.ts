/**
 * POST /api/admin/login  { pin } — exchange the shared PIN for a short-lived signed token.
 */
import { z } from 'zod';
import { checkPin, issueToken } from '../_lib/auth.js';
import { HttpError, rateLimit, route } from '../_lib/http.js';

const Body = z.object({ pin: z.string().min(1).max(32) });

export default route('admin-login', {
  POST: async (ctx) => {
    // Slow down PIN guessing.
    rateLimit(`login:${ctx.ip}`, 10, 5 * 60_000);
    const input = Body.parse(ctx.body);
    if (!checkPin(input.pin)) throw new HttpError(401, 'wrong_pin', 'That PIN is not right.');
    return issueToken();
  },
});
