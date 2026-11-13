/**
 * GET /api/audio?id=... — play back a recorded audio tip stored in the database.
 *
 * Only used when no Supabase Storage bucket is configured (local dev, tests);
 * with Storage, clips are served straight from the bucket. iPhone Safari asks
 * for audio in byte ranges and will not play without them, so Range requests
 * are answered properly (206 Partial Content).
 */
import { getDb } from './_lib/db.js';
import { HttpError, RawResponse, route } from './_lib/http.js';
import { uuid } from './_lib/repo.js';

export default route('audio', {
  GET: async (ctx) => {
    const id = uuid.parse(ctx.query.get('id') ?? '');
    const rows = await getDb().query<{ mime: string; data: string }>(
      `select mime, encode(bytes, 'base64') as data from audio_clips where id = $1::uuid`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'audio_not_found', 'That recording is no longer here.');
    const bytes = Buffer.from(String(rows[0].data).replace(/\s/g, ''), 'base64');
    const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(ctx.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const total = bytes.length;
      // "bytes=-500" means the last 500 bytes.
      const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) {
        return new RawResponse(rows[0].mime, '', { ...headers, 'Content-Range': `bytes */${total}` }, 416);
      }
      const part = bytes.subarray(start, end + 1);
      return new RawResponse(
        rows[0].mime,
        part,
        { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(part.length) },
        206,
      );
    }
    return new RawResponse(rows[0].mime, bytes, { ...headers, 'Content-Length': String(bytes.length) });
  },
});
