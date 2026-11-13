/**
 * GET /api/stations?code=shoulder-press — look up a station by its QR code.
 * Without `code`, lists every station (there is exactly one in this prototype).
 */
import { z } from 'zod';
import type { Station } from '../shared/types.js';
import { getDb } from './_lib/db.js';
import { route } from './_lib/http.js';
import { getStationByCode } from './_lib/repo.js';

const Code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);

export default route('stations', {
  GET: async (ctx) => {
    const db = getDb();
    const code = ctx.query.get('code');
    if (code) return { station: await getStationByCode(db, Code.parse(code)) };
    const rows = await db.query<Station>('select id, name, code from stations order by name limit 50');
    return { stations: rows };
  },
});
