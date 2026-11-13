/**
 * Admin auth: the shared PIN is checked on the server and exchanged for a
 * short-lived HMAC-signed token. The PIN itself is never stored in the browser
 * beyond the login request.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, type Ctx } from './http.js';

const TOKEN_TTL_SECONDS = 2 * 60 * 60;
const LOCAL_DEV_PIN = '2468';

function configuredPin(): string {
  const pin = process.env.ADMIN_PIN;
  if (pin && pin.trim()) return pin.trim();
  // On Vercel a missing PIN must never fall back to a known value.
  if (process.env.VERCEL) throw new HttpError(503, 'pin_not_set', 'ADMIN_PIN is not set for this deployment.');
  return LOCAL_DEV_PIN;
}

function secret(): Buffer {
  const explicit = process.env.ADMIN_TOKEN_SECRET;
  const material = explicit && explicit.trim() ? explicit : `ar-gym:${configuredPin()}:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`;
  return createHash('sha256').update(material).digest();
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function checkPin(pin: string): boolean {
  return safeEqual(pin.trim(), configuredPin());
}

export function issueToken(nowMs = Date.now()): { token: string; expires_at: string } {
  const exp = Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ exp, scope: 'admin' })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function verifyToken(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number; scope?: string };
    return data.scope === 'admin' && typeof data.exp === 'number' && data.exp * 1000 > nowMs;
  } catch {
    return false;
  }
}

/** Throws 401 unless the request carries a valid admin token. */
export function requireAdmin(ctx: Ctx): void {
  const header = ctx.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  // The CSV export is opened as a plain link, so it may pass the token as a query parameter.
  const token = bearer ?? ctx.query.get('token') ?? undefined;
  if (!verifyToken(token)) throw new HttpError(401, 'unauthorized', 'Enter the admin PIN to continue.');
}
