/**
 * Test helpers: call an API route handler directly with a fake request and
 * capture the response, against a throwaway in-memory Postgres.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface CallResult<T = any> {
  status: number;
  headers: Record<string, string>;
  json: T;
  text: string;
  /** The raw body, for binary answers (audio clips). */
  bytes: Buffer;
}

export async function call<T = any>(
  handler: Handler,
  options: { method?: 'GET' | 'POST'; url?: string; body?: unknown; token?: string; ip?: string; headers?: Record<string, string> } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? '10.0.0.1', ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers,
    body: options.body ?? {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;

  const captured: Record<string, string> = {};
  let text = '';
  let bytes = Buffer.alloc(0);
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      captured[name.toLowerCase()] = String(value);
    },
    end(body?: string | Uint8Array) {
      if (typeof body === 'string' || body === undefined) text = body ?? '';
      else bytes = Buffer.from(body);
    },
  };
  await handler(req, res as unknown as ServerResponse);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // not JSON (the CSV export)
  }
  return { status: res.statusCode, headers: captured, json: json as T, text, bytes: bytes.length ? bytes : Buffer.from(text) };
}
