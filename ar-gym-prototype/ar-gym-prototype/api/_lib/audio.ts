/**
 * Recorded audio tips: validation and storage.
 *
 * A clip arrives as base64 inside the JSON request. It is checked three ways
 * before anything is stored: the declared type must be one phones actually
 * record, the bytes must really look like that type (the first bytes of the
 * file are inspected), and it must be 1 MB or smaller.
 *
 * Where it goes:
 *   - Supabase configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): a public
 *     Storage bucket, created on first use with the same 1 MB cap and type list.
 *   - Otherwise (local dev, tests): the audio_clips table, served by /api/audio.
 */
import { AUDIO_MAX_BYTES, AUDIO_MIME_TYPES } from '../../shared/text.js';
import type { Db } from './db.js';
import { HttpError } from './http.js';

export const AUDIO_BUCKET = 'breadcrumb-audio';
export type AudioMime = (typeof AUDIO_MIME_TYPES)[number];

const EXTENSION: Record<AudioMime, string> = {
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
};

/** "audio/webm;codecs=opus" -> "audio/webm". Anything not on the list is refused. */
export function cleanMime(raw: string): AudioMime {
  const base = raw.split(';')[0].trim().toLowerCase();
  const mime = base === 'audio/x-m4a' || base === 'audio/m4a' ? 'audio/mp4' : base;
  if (!(AUDIO_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new HttpError(415, 'audio_type', 'That audio format is not supported.');
  }
  return mime as AudioMime;
}

/** Does the file start the way a file of this type starts? Stops "any bytes labelled as audio". */
export function looksLike(mime: AudioMime, bytes: Uint8Array): boolean {
  const at = (offset: number, text: string) => text.split('').every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
  switch (mime) {
    case 'audio/webm':
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3; // EBML header
    case 'audio/mp4':
      return at(4, 'ftyp');
    case 'audio/ogg':
      return at(0, 'OggS');
    case 'audio/mpeg':
      return at(0, 'ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case 'audio/aac':
      return bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0; // ADTS sync word
  }
}

/** Decode and check an uploaded clip. Throws a friendly error for anything out of bounds. */
export function readClip(base64: string, rawMime: string): { mime: AudioMime; bytes: Buffer } {
  const mime = cleanMime(rawMime);
  // 4 base64 characters carry 3 bytes: refuse an oversized clip before decoding it.
  if (base64.length > Math.ceil((AUDIO_MAX_BYTES * 4) / 3) + 8) {
    throw new HttpError(413, 'audio_too_large', 'That recording is too large. Keep it under 20 seconds.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400, 'audio_invalid', 'We could not read that recording.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'audio_empty', 'That recording is empty. Try again.');
  if (bytes.length > AUDIO_MAX_BYTES) throw new HttpError(413, 'audio_too_large', 'That recording is too large. Keep it under 20 seconds.');
  if (!looksLike(mime, bytes)) throw new HttpError(415, 'audio_type', 'That file is not the audio format it says it is.');
  return { mime, bytes };
}

function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

async function uploadToBucket(config: { url: string; key: string }, path: string, mime: AudioMime, bytes: Buffer): Promise<Response> {
  return fetch(`${config.url}/storage/v1/object/${AUDIO_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': mime, 'Cache-Control': '3600' },
    body: new Uint8Array(bytes),
  });
}

/** Store a checked clip and return the URL a phone can play it from. */
export async function storeClip(db: Db, id: string, mime: AudioMime, bytes: Buffer): Promise<string> {
  const config = supabase();
  if (config) {
    const path = `${id}.${EXTENSION[mime]}`;
    let response = await uploadToBucket(config, path, mime, bytes);
    if (!response.ok && (response.status === 404 || response.status === 400)) {
      // First clip ever: make the bucket (public to read, 1 MB cap, audio types only), then try once more.
      await fetch(`${config.url}/storage/v1/bucket`, {
        method: 'POST',
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: AUDIO_BUCKET,
          name: AUDIO_BUCKET,
          public: true,
          file_size_limit: AUDIO_MAX_BYTES,
          allowed_mime_types: [...AUDIO_MIME_TYPES],
        }),
      });
      response = await uploadToBucket(config, path, mime, bytes);
    }
    if (!response.ok) {
      console.error('[audio] storage upload failed', response.status, await response.text().catch(() => ''));
      throw new HttpError(502, 'audio_store', 'We could not save that recording. Please try again.');
    }
    return `${config.url}/storage/v1/object/public/${AUDIO_BUCKET}/${path}`;
  }
  await db.query(`insert into audio_clips (id, mime, bytes) values ($1::uuid, $2, decode($3, 'base64'))`, [
    id,
    mime,
    bytes.toString('base64'),
  ]);
  return `/api/audio?id=${id}`;
}
