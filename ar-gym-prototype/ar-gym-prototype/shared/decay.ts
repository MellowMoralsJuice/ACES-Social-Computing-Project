/**
 * Decay and ranking — the heart of the prototype.
 *
 * Everything here is a pure function. Freshness is NEVER stored as a live
 * value and no job loops over rows to update it. Each breadcrumb stores a
 * base score plus the time of its last interaction, and the current score
 * is derived in O(1) whenever something reads it:
 *
 *   freshness = base_freshness * 0.5 ^ (elapsed / halfLife)
 *
 *   halfLife  = busyness half-life            (quiet 14d, normal 7d, packed 3.5d)
 *             * (1 + log2(1 + support))       (well-supported tips last longer)
 *             / decay_multiplier              (admin speed control)
 *
 *   support   = max(0, useful - not_useful) + helped
 *
 * "elapsed" is measured on the virtual clock (real time + the time-skip
 * offset held in the single settings row), so a Fast-forward shifts one
 * number instead of rewriting breadcrumb rows.
 *
 * Admin pins are applied here too, at read time: keep_fresh reads as 100,
 * and force_stale reads as aged-out once any time-skip is in effect.
 */
import type { Busyness, DecayFields, VoteValue } from './types.js';

export const DAY_SECONDS = 86_400;

export const DECAY = {
  /** Half-life in days for an unsupported tip, by gym busyness. */
  halfLifeDays: { quiet: 14, normal: 7, packed: 3.5 } as Record<Busyness, number>,
  /** State boundaries on the 0-100 freshness scale. */
  thresholds: { fading: 60, stale: 35, gone: 15 },
  /** What a forced-stale breadcrumb reads as after a time-skip. */
  forcedStaleValue: 8,
  /** Freshness added (or removed) by each kind of interaction. */
  delta: { useful: 12, not_useful: -15, helped: 8, duplicate: 8 },
  /** Ranking weights. */
  rank: { useful: 4, notUseful: 4, helped: 3, verified: 10, loaf: 5, flagged: -15 },
} as const;

export type FreshnessState = 'fresh' | 'fading' | 'stale' | 'gone';
export type InteractionKind = VoteValue | 'helped' | 'duplicate';

/** Everything about "now" that the decay rule needs. */
export interface DecayClock {
  /** Virtual now in ms: real time + global offset + this phone's scripted skip. */
  nowMs: number;
  busyness: Busyness;
  /** Admin decay speed, 1 = normal. */
  multiplier: number;
  /** True when any time-skip is in effect (arms force_stale pins). */
  skipActive: boolean;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Net community support for a tip. */
export function supportOf(c: Pick<DecayFields, 'useful_count' | 'not_useful_count' | 'helped_count'>): number {
  return Math.max(0, c.useful_count - c.not_useful_count) + Math.max(0, c.helped_count);
}

/** Half-life in seconds for one breadcrumb under the current gym conditions. */
export function halfLifeSeconds(
  c: Pick<DecayFields, 'useful_count' | 'not_useful_count' | 'helped_count'>,
  busyness: Busyness,
  multiplier = 1,
): number {
  const base = DECAY.halfLifeDays[busyness] * DAY_SECONDS;
  const resilience = 1 + Math.log2(1 + supportOf(c));
  return (base * resilience) / Math.max(0.01, multiplier);
}

/** Current freshness (0-100), derived at read time. O(1). */
export function freshnessAt(c: DecayFields, clock: DecayClock): number {
  if (c.pin_state === 'keep_fresh') return 100;
  const last = new Date(c.last_interaction_at).getTime();
  // A tip touched "in the future" (by a phone that already skipped ahead) has simply not decayed yet.
  const elapsedSeconds = Math.max(0, (clock.nowMs - last) / 1000);
  const halfLife = halfLifeSeconds(c, clock.busyness, clock.multiplier);
  const value = clamp(c.base_freshness * Math.pow(0.5, elapsedSeconds / halfLife), 0, 100);
  // "Make stale" bites at the next time-skip (so it never yanks a tip away mid-read): after any skip the
  // tip is shown as faded out, whatever its votes say.
  if (c.pin_state === 'force_stale' && clock.skipActive) {
    return Math.min(value, DECAY.forcedStaleValue);
  }
  return value;
}

export function freshnessState(freshness: number): FreshnessState {
  const t = DECAY.thresholds;
  if (freshness >= t.fading) return 'fresh';
  if (freshness >= t.stale) return 'fading';
  if (freshness >= t.gone) return 'stale';
  return 'gone';
}

/**
 * Re-base a breadcrumb when someone interacts with it: take what its freshness
 * is right now, add the interaction's delta, and restart the clock.
 */
export function applyInteraction(
  c: DecayFields,
  kind: InteractionKind,
  clock: DecayClock,
): { base_freshness: number; last_interaction_at: string } {
  // Pins are a display-time override, so compute the true underlying value.
  const current = freshnessAt({ ...c, pin_state: 'none' }, clock);
  return {
    base_freshness: clamp(current + DECAY.delta[kind], 0, 100),
    last_interaction_at: new Date(clock.nowMs).toISOString(),
  };
}

export interface RankInput {
  useful_count: number;
  not_useful_count: number;
  helped_count: number;
  is_verified: boolean;
  is_flagged: boolean;
  has_loaf_badge: boolean;
}

/**
 * Ranking score. Votes and freshness set the base, the verified check and the
 * Loaf badge give a modest boost, and a safety flag pushes a tip down (it is
 * labelled, never deleted). The server stores this in breadcrumbs.rank_score
 * whenever a vote lands so "top N per layer" is an indexed ORDER BY ... LIMIT.
 */
export function rankScore(c: RankInput, freshness: number): number {
  const w = DECAY.rank;
  const score =
    freshness +
    w.useful * Math.log2(1 + c.useful_count) -
    w.notUseful * Math.log2(1 + c.not_useful_count) +
    w.helped * Math.log2(1 + c.helped_count) +
    (c.is_verified ? w.verified : 0) +
    (c.has_loaf_badge ? w.loaf : 0) +
    (c.is_flagged ? w.flagged : 0);
  return Math.round(score * 100) / 100;
}

/** Virtual "now" for a phone, given real time and the two offsets. */
export function virtualNowMs(realNowMs: number, globalOffsetSeconds: number, sessionSkipSeconds = 0): number {
  return realNowMs + (globalOffsetSeconds + sessionSkipSeconds) * 1000;
}

/** The time-skips the Fast-forward control offers. */
export const TIME_SKIPS = [
  { key: 'day', label: '+1 day', seconds: DAY_SECONDS },
  { key: 'week', label: '+1 week', seconds: 7 * DAY_SECONDS },
  { key: 'month', label: '+1 month', seconds: 30 * DAY_SECONDS },
] as const;

/** Length of the scripted per-phone skip in Auto mode ("One week later"). */
export const SCRIPTED_SKIP_SECONDS = 7 * DAY_SECONDS;
