/**
 * Behavior logging. Events are queued in memory and flushed to /api/events in
 * small batches, so logging never slows the interface down and survives a
 * brief wifi drop. The server stamps the group tag and time; the client only says
 * what happened.
 */
import type { ClientEventType } from '../../shared/events';
import type { BehaviorEventInput } from '../../shared/types';

const FLUSH_MS = 3000;
const MAX_BATCH = 30;
const MAX_QUEUE = 300;

let sessionId: string | null = null;
let queue: BehaviorEventInput[] = [];
let timer: number | null = null;
let sending = false;

export function setTrackerSession(id: string | null): void {
  if (id !== sessionId) queue = [];
  sessionId = id;
}

export function track(event_type: ClientEventType, metadata: Record<string, unknown> = {}, breadcrumbId?: string | null): void {
  if (!sessionId) return;
  queue.push({ event_type, metadata, breadcrumb_id: breadcrumbId ?? null, at: Date.now() });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (timer === null) timer = window.setTimeout(() => void flush(), FLUSH_MS);
}

export async function flush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (sending || !sessionId || queue.length === 0) return;
  sending = true;
  const batch = queue.slice(0, MAX_BATCH);
  try {
    const response = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, events: batch }),
      keepalive: true,
    });
    // Drop the batch on success, and also on a 4xx (retrying a rejected batch would loop forever).
    if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
      queue = queue.slice(batch.length);
    }
  } catch {
    /* offline: keep the queue and try again on the next flush */
  } finally {
    sending = false;
    if (queue.length > 0 && timer === null) timer = window.setTimeout(() => void flush(), FLUSH_MS);
  }
}

// Send whatever is left when the page is hidden or closed.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => void flush());
}
