/**
 * A very small wrapper around Vercel's Node request/response so every route
 * gets the same behavior: method routing, JSON body parsing with a size cap,
 * Zod validation errors turned into friendly 400s, rate limiting, and server
 * error logging. It only relies on plain Node http objects, so the same
 * handlers run on Vercel and on the local dev server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Return this from a handler to send something other than JSON (the CSV export, an audio clip). */
export class RawResponse {
  constructor(
    public contentType: string,
    public body: string | Uint8Array,
    public headers: Record<string, string> = {},
    public status = 200,
  ) {}
}

export interface Ctx {
  method: string;
  query: URLSearchParams;
  body: unknown;
  ip: string;
  headers: IncomingMessage['headers'];
}

type Handler = (ctx: Ctx) => Promise<unknown>;

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

// --- Rate limiting -----------------------------------------------------------
// Fixed-window counters held in memory. On Vercel each warm function instance
// keeps its own counters, so this is a best-effort brake on runaway clients,
// which is the right size for a classroom prototype. Durable limits (one vote
// per participant, a cap on tips per session) are enforced in the database.
const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  if (windows.size > 5000) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  }
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > max) {
    throw new HttpError(429, 'rate_limited', 'Slow down a little. Try again in a few seconds.');
  }
}

/** Test helper. */
export function resetRateLimits(): void {
  windows.clear();
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return (first ?? req.socket?.remoteAddress ?? 'unknown').trim();
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Vercel has already parsed the body for us.
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preParsed !== undefined) {
    if (typeof preParsed === 'string') return preParsed ? JSON.parse(preParsed) : {};
    if (Buffer.isBuffer(preParsed)) return preParsed.length ? JSON.parse(preParsed.toString('utf8')) : {};
    return preParsed ?? {};
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * Build a route handler. `name` keys the per-IP write limit.
 * `maxBodyBytes` raises the request size cap for the one route that accepts an audio clip.
 */
export function route(name: string, handlers: { GET?: Handler; POST?: Handler }, options: { maxBodyBytes?: number } = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const fn = method === 'GET' ? handlers.GET : method === 'POST' ? handlers.POST : undefined;
      if (!fn) {
        res.setHeader('Allow', Object.keys(handlers).join(', '));
        throw new HttpError(405, 'method_not_allowed', 'That action is not supported here.');
      }
      const ip = clientIp(req);
      // A whole classroom can share one public IP, so the per-IP ceiling is generous;
      // tighter per-participant limits are applied inside the handlers.
      if (method === 'POST') rateLimit(`ip:${name}:${ip}`, 900, 60_000);

      let body: unknown = {};
      if (method === 'POST') {
        try {
          body = await readBody(req, maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, 'bad_json', 'We could not read that request.');
        }
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > maxBodyBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const result = await fn({ method, query: url.searchParams, body, ip, headers: req.headers });

      if (result instanceof RawResponse) {
        res.statusCode = result.status;
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Cache-Control', 'no-store');
        for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
        res.end(typeof result.body === 'string' ? result.body : Buffer.from(result.body));
        return;
      }
      send(res, 200, result ?? { ok: true });
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, { error: { code: error.code, message: error.message } });
      } else if (error instanceof ZodError) {
        const issue = error.issues[0];
        const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
        send(res, 400, { error: { code: 'invalid_input', message: `${where}${issue?.message ?? 'Invalid input'}` } });
      } else {
        console.error(`[api:${name}]`, error);
        send(res, 500, { error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
      }
    }
  };
}
