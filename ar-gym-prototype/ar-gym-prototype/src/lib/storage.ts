/** localStorage helpers that never throw (private mode, full disk, blocked storage). */

export function loadJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the app still works, it just will not remember */
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Where one participant's in-progress survey answers are kept, so a refresh does not lose them. */
export function surveyKey(sessionId: string): string {
  return `argym.survey.${sessionId}`;
}

export const KEYS = {
  session: 'argym.session.v3',
  // v4: breadcrumbs are text or audio; there are no hotspots, layers or roles.
  content: 'argym.content.v4',
  adminToken: 'argym.admin.v1',
  /** Session id of the participant who has already seen the one-time Loaf hint. */
  loafHint: 'argym.hint.loaf',
  /** Session id of the participant who dismissed "Turn your phone sideways". */
  turnHint: 'argym.hint.turn',
};
