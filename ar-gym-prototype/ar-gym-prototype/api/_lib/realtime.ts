/**
 * Supabase Realtime, server side.
 *
 * Vercel functions cannot hold connections open, so after a write the function
 * sends ONE HTTP request to Supabase's Realtime "broadcast" endpoint. Every
 * phone subscribed to the channel gets a tiny "something changed" message and
 * refetches through /api. No table is exposed to the browser.
 *
 * If Supabase is not configured (local dev) or the call fails, nothing breaks:
 * phones fall back to polling /api/state every 2 seconds.
 */
import { REALTIME_CHANNEL, REALTIME_EVENT } from '../../shared/events.js';

export type ChangeKind = 'state' | 'content';

export async function broadcastChange(kind: ChangeKind): Promise<void> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: REALTIME_CHANNEL, event: REALTIME_EVENT, payload: { kind, at: Date.now() } }],
      }),
    });
    if (!response.ok) console.error('[realtime] broadcast failed', response.status);
  } catch (error) {
    console.error('[realtime] broadcast error', error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timer);
  }
}
