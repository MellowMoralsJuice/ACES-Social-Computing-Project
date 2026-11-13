/**
 * The small data-fetching layer. Every call goes to /api on the same domain,
 * has a timeout, and turns failures into an ApiFailure with a message that is
 * safe to show a participant.
 */
import type { ApiError } from '../../shared/types';

export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
  /** True when the server could not be reached at all (offline, flaky wifi). */
  get offline(): boolean {
    return this.status === 0;
  }
}

const TIMEOUT_MS = 8000;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure("Can't reach the gym right now. Check the wifi and try again.", 0, 'offline');
  } finally {
    window.clearTimeout(timer);
  }

  // A non-JSON body (a proxy error page, say) is treated as "no details".
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as ApiError | null)?.error;
    throw new ApiFailure(error?.message ?? 'Something went wrong. Please try again.', response.status, error?.code ?? 'error');
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, token?: string) => request<T>('GET', path, undefined, token),
  post: <T>(path: string, body: unknown, token?: string) => request<T>('POST', path, body, token),
};
