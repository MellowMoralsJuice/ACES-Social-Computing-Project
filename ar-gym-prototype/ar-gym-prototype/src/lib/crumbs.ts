/**
 * Turns raw breadcrumbs into what a tab's list shows: live freshness and
 * state (derived, never stored), a live rank, and the split into
 * "top few / see more / faded away".
 */
import { DAY_SECONDS, freshnessAt, freshnessState, rankScore, type DecayClock, type FreshnessState } from '../../shared/decay';
import type { Breadcrumb, BreadcrumbKind } from '../../shared/types';

/** Each tab shows only this many breadcrumbs until "See more" is tapped. */
export const TOP_COUNT = 3;
const NEW_WINDOW_MS = 10 * 60 * 1000;

export interface CrumbView {
  crumb: Breadcrumb;
  freshness: number;
  state: FreshnessState;
  rank: number;
  /** Posted in the last few minutes by a participant: floats to the top so the live loop is visible. */
  isNew: boolean;
}

export function viewOf(crumb: Breadcrumb, clock: DecayClock): CrumbView {
  const freshness = freshnessAt(crumb, clock);
  const age = clock.nowMs - new Date(crumb.created_at).getTime();
  return {
    crumb,
    freshness,
    state: freshnessState(freshness),
    rank: rankScore({ ...crumb, has_loaf_badge: crumb.contributor.has_loaf_badge }, freshness),
    isNew: !crumb.contributor.is_seeded && age < NEW_WINDOW_MS,
  };
}

export interface TabList {
  top: CrumbView[];
  more: CrumbView[];
  /** Below the "gone" threshold: hidden from the list, still in the database. */
  gone: CrumbView[];
  total: number;
}

/**
 * One tab's breadcrumbs (Text or Audio), best first. Ranking = freshness + votes + thanks, with a
 * boost for the Loaf badge and the verified check and a penalty for a flagged tip (see rankScore).
 * `tag` narrows by a filter chip; `pinnedFirstId` keeps the participant's own just-posted tip on
 * top, and anything posted in the last few minutes floats above the rest so new tips land at the top.
 */
export function tabList(
  crumbs: Breadcrumb[],
  clock: DecayClock,
  kind: BreadcrumbKind,
  tag: string | null,
  pinnedFirstId: string | null,
): TabList {
  const views = crumbs
    .filter((b) => b.kind === kind && (!tag || b.tags.includes(tag)))
    .map((b) => viewOf(b, clock))
    .sort((a, b) => {
      if (a.crumb.id === pinnedFirstId) return -1;
      if (b.crumb.id === pinnedFirstId) return 1;
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      return b.rank - a.rank;
    });
  const visible = views.filter((v) => v.state !== 'gone');
  return {
    top: visible.slice(0, TOP_COUNT),
    more: visible.slice(TOP_COUNT),
    gone: views.filter((v) => v.state === 'gone'),
    total: views.length,
  };
}

/** How many tips are still showing (not yet faded away), for one tab or for the Breadcrumbs button. */
export function liveCount(crumbs: Breadcrumb[], clock: DecayClock, kind?: BreadcrumbKind): number {
  return crumbs.filter((b) => (!kind || b.kind === kind) && freshnessState(freshnessAt(b, clock)) !== 'gone').length;
}

export const STATE_LABEL: Record<FreshnessState, string> = {
  fresh: 'Fresh',
  fading: 'Fading',
  stale: 'Stale',
  gone: 'Faded away',
};

/** "1 week later", "8 days later" — the label for however much virtual time has passed. */
export function offsetLabel(seconds: number): string | null {
  if (seconds <= 0) return null;
  const days = Math.round(seconds / DAY_SECONDS);
  if (days < 1) return 'Later today';
  if (days === 1) return '1 day later';
  if (days === 7) return '1 week later';
  if (days === 30) return '1 month later';
  if (days % 7 === 0 && days < 30) return `${days / 7} weeks later`;
  return `${days} days later`;
}

/** A short handle for logs ("Stack your wrists…"). */
export function crumbLabel(crumb: Breadcrumb): string {
  const text = crumb.body || 'Voice recording';
  return text.length > 40 ? `${text.slice(0, 38)}…` : text;
}

/** "0:07" */
export function clockLabel(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
