/**
 * Small device helpers for a phone that is being held up for minutes at a time.
 */
import { useEffect, useState } from 'react';

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

/**
 * Keep the screen awake while `active`. Without this a phone dims and locks
 * part-way through reading a tip, because nobody is touching it.
 * Not every browser supports it; where it is missing nothing happens.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await wakeLock.request('screen');
        if (cancelled) void next.release();
        else sentinel = next;
      } catch {
        /* low battery or not allowed: carry on without it */
      }
    };
    void acquire();
    // The lock is dropped whenever the page is hidden, so take it again on return.
    const onVisible = () => void acquire();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

/**
 * True while the phone is held upright. The glasses view is landscape, and web
 * pages cannot reliably lock orientation (iPhone Safari never allows it), so
 * the app watches the orientation and asks for a turn instead.
 */
export function useIsPortrait(): boolean {
  const query = '(orientation: portrait)';
  const [portrait, setPortrait] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setPortrait(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return portrait;
}

/**
 * Size the app to the part of the screen that is actually visible.
 *
 * On iPhones the on-screen keyboard covers the page instead of resizing it,
 * which would hide a text box at the bottom of the screen (the tip field, the
 * survey). Tracking the visual viewport keeps the whole layout above the
 * keyboard.
 */
export function trackVisibleHeight(): void {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty('--app-height', `${Math.round(viewport?.height ?? window.innerHeight)}px`);
    // Safari scrolls the page to reveal a focused field; the layout already fits, so undo that.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  apply();
  viewport?.addEventListener('resize', apply);
  viewport?.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
}
