/**
 * Supabase Realtime, browser side.
 *
 * The phone subscribes to one broadcast channel. The message carries no data:
 * it only means "something changed", and the app then refetches through /api.
 * If Supabase is not configured, or the socket cannot connect, the caller
 * falls back to polling /api/state every 2 seconds.
 */
import { REALTIME_CHANNEL, REALTIME_EVENT } from '../../shared/events';

export interface RealtimeHandle {
  stop: () => void;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const realtimeConfigured = Boolean(url && anonKey);

export function startRealtime(onChange: () => void, onStatus: (connected: boolean) => void): RealtimeHandle {
  if (!url || !anonKey) {
    onStatus(false);
    return { stop: () => {} };
  }
  let stopped = false;
  let cleanup: (() => void) | null = null;

  // Loaded on demand so phones without Supabase configured never download it.
  void import('@supabase/supabase-js')
    .then(({ createClient }) => {
      if (stopped) return;
      const client = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 5 } },
      });
      const channel = client
        .channel(REALTIME_CHANNEL)
        .on('broadcast', { event: REALTIME_EVENT }, () => onChange())
        .subscribe((status) => {
          if (stopped) return;
          onStatus(status === 'SUBSCRIBED');
        });
      cleanup = () => {
        void client.removeChannel(channel);
        void client.realtime.disconnect();
      };
    })
    .catch(() => onStatus(false));

  return {
    stop: () => {
      stopped = true;
      cleanup?.();
    },
  };
}
