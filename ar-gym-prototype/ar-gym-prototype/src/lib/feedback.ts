/** A tiny haptic buzz so a tap feels like an air tap landing (where the browser supports it). */
export function buzz(ms = 12): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(ms);
  } catch {
    /* not supported */
  }
}
