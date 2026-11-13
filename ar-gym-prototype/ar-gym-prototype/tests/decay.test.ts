import { describe, expect, it } from 'vitest';
import {
  DAY_SECONDS,
  DECAY,
  applyInteraction,
  freshnessAt,
  freshnessState,
  halfLifeSeconds,
  rankScore,
  supportOf,
  virtualNowMs,
  type DecayClock,
} from '../shared/decay';
import { DEV_SCRIPT, MAYA_SCRIPT, SEED_BREADCRUMBS, SEED_CONTRIBUTORS } from '../shared/seed';
import type { Busyness, DecayFields } from '../shared/types';

const NOW = Date.UTC(2026, 10, 13, 18, 0, 0);
const HOUR = 3_600_000;

function clock(offsetDays = 0, busyness: Busyness = 'normal', multiplier = 1): DecayClock {
  return {
    nowMs: virtualNowMs(NOW, offsetDays * DAY_SECONDS),
    busyness,
    multiplier,
    skipActive: offsetDays > 0,
  };
}

function seeded(nickname: string): DecayFields {
  const b = SEED_BREADCRUMBS.find((crumb) => crumb.nickname === nickname)!;
  return {
    base_freshness: b.base_freshness,
    last_interaction_at: new Date(NOW - b.lastInteractionHoursAgo * HOUR).toISOString(),
    useful_count: b.useful_count,
    not_useful_count: b.not_useful_count,
    helped_count: b.helped_count,
    pin_state: 'none',
  };
}

const fresh: DecayFields = {
  base_freshness: 100,
  last_interaction_at: new Date(NOW).toISOString(),
  useful_count: 0,
  not_useful_count: 0,
  helped_count: 0,
  pin_state: 'none',
};

describe('decay rule', () => {
  it('starts at the base score and never changes without time passing', () => {
    expect(freshnessAt(fresh, clock())).toBe(100);
  });

  it('halves an unsupported tip after one half-life (7 days in a normal gym)', () => {
    expect(freshnessAt(fresh, clock(7))).toBeCloseTo(50, 5);
    expect(freshnessAt(fresh, clock(14))).toBeCloseTo(25, 5);
  });

  it('decays faster in a busier gym and slower in a quiet one', () => {
    const quiet = freshnessAt(fresh, clock(7, 'quiet'));
    const normal = freshnessAt(fresh, clock(7, 'normal'));
    const packed = freshnessAt(fresh, clock(7, 'packed'));
    expect(quiet).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(packed);
    expect(quiet).toBeCloseTo(100 * Math.pow(0.5, 0.5), 5);
    expect(packed).toBeCloseTo(25, 5);
  });

  it('respects the admin decay speed multiplier', () => {
    expect(freshnessAt(fresh, clock(7, 'normal', 2))).toBeCloseTo(25, 5);
    expect(freshnessAt(fresh, clock(7, 'normal', 0.5))).toBeCloseTo(100 * Math.pow(0.5, 0.5), 5);
  });

  it('gives well-supported tips a longer half-life', () => {
    const loved = { ...fresh, useful_count: 14, helped_count: 12 };
    expect(supportOf(loved)).toBe(26);
    expect(halfLifeSeconds(loved, 'normal')).toBeGreaterThan(halfLifeSeconds(fresh, 'normal') * 5);
    expect(freshnessAt(loved, clock(7))).toBeGreaterThan(85);
  });

  it('does not let not-useful votes add support', () => {
    expect(supportOf({ useful_count: 1, not_useful_count: 6, helped_count: 0 })).toBe(0);
  });

  it('never goes negative or above 100, and treats future interactions as "no time passed"', () => {
    expect(freshnessAt(fresh, clock(3650))).toBeGreaterThanOrEqual(0);
    const future = { ...fresh, last_interaction_at: new Date(NOW + 5 * 24 * HOUR).toISOString() };
    expect(freshnessAt(future, clock())).toBe(100);
  });

  it('maps freshness to the four visible states', () => {
    expect(freshnessState(100)).toBe('fresh');
    expect(freshnessState(DECAY.thresholds.fading)).toBe('fresh');
    expect(freshnessState(59.9)).toBe('fading');
    expect(freshnessState(34.9)).toBe('stale');
    expect(freshnessState(14.9)).toBe('gone');
  });

  it('is O(1): the result depends only on the stored row and the clock', () => {
    const a = freshnessAt(seeded('middling'), clock(7));
    const b = freshnessAt(seeded('middling'), clock(7));
    expect(a).toBe(b);
  });
});

describe('admin pins are applied at read time', () => {
  it('keep_fresh survives any time-skip', () => {
    expect(freshnessAt({ ...seeded('ignored-old'), pin_state: 'keep_fresh' }, clock(30))).toBe(100);
  });

  it('force_stale ages out at the next skip, and not before', () => {
    const pinned = { ...seeded('popular'), pin_state: 'force_stale' as const };
    expect(freshnessState(freshnessAt(pinned, clock(0)))).toBe('fresh');
    expect(freshnessState(freshnessAt(pinned, clock(1)))).toBe('gone');
  });
});

describe('interactions re-base freshness', () => {
  it('a useful vote raises freshness and restarts the clock', () => {
    const stale = seeded('ignored-old');
    const before = freshnessAt(stale, clock());
    const next = applyInteraction(stale, 'useful', clock());
    expect(next.base_freshness).toBeCloseTo(before + DECAY.delta.useful, 5);
    expect(new Date(next.last_interaction_at).getTime()).toBe(NOW);
  });

  it('a not-useful vote lowers freshness', () => {
    const next = applyInteraction(fresh, 'not_useful', clock());
    expect(next.base_freshness).toBe(100 + DECAY.delta.not_useful);
  });

  it('clamps to 0..100', () => {
    expect(applyInteraction(fresh, 'useful', clock()).base_freshness).toBe(100);
    const nearlyGone = { ...fresh, base_freshness: 5 };
    expect(applyInteraction(nearlyGone, 'not_useful', clock()).base_freshness).toBe(0);
  });
});

describe('seed mix produces the rehearsed time-skip outcome (README table)', () => {
  const stateAfter = (nickname: string, days: number) => freshnessState(freshnessAt(seeded(nickname), clock(days)));

  it('at the start: the trusted and popular tips are bright, the two ignored ones are already going', () => {
    expect(stateAfter('popular', 0)).toBe('fresh');
    expect(stateAfter('popular-flagged', 0)).toBe('fresh');
    expect(stateAfter('fresh-audio', 0)).toBe('fresh');
    expect(stateAfter('middling', 0)).toBe('fresh');
    expect(stateAfter('ignored-audio', 0)).toBe('fading'); // Dev's old clip: "fading"
    expect(stateAfter('ignored-old', 0)).toBe('stale');
  });

  it('+1 day: nothing dramatic', () => {
    expect(stateAfter('popular', 1)).toBe('fresh');
    expect(stateAfter('fresh-audio', 1)).toBe('fresh');
    expect(stateAfter('ignored-audio', 1)).toBe('fading');
    expect(stateAfter('ignored-old', 1)).toBe('stale');
  });

  it('+1 week: the ignored text tip leaves the list, the middling one dims, popular ones stay bright', () => {
    expect(stateAfter('popular', 7)).toBe('fresh');
    expect(stateAfter('popular-flagged', 7)).toBe('fresh');
    expect(stateAfter('fresh-audio', 7)).toBe('fresh');
    expect(stateAfter('middling', 7)).toBe('fading');
    expect(stateAfter('ignored-audio', 7)).toBe('stale');
    expect(stateAfter('ignored-old', 7)).toBe('gone');
  });

  it('+1 month: the middling tip has faded out too, and so has the ignored clip', () => {
    expect(stateAfter('middling', 30)).toBe('gone');
    expect(stateAfter('ignored-audio', 30)).toBe('gone');
    expect(stateAfter('ignored-old', 30)).toBe('gone');
    expect(['fresh', 'fading']).toContain(stateAfter('popular', 30));
    expect(['fresh', 'fading']).toContain(stateAfter('fresh-audio', 30));
  });

  it('a packed gym tightens decay: the middling tip is already stale after a week', () => {
    const packed = freshnessState(freshnessAt(seeded('middling'), clock(7, 'packed')));
    expect(packed).toBe('stale');
  });

  it('keeps the seed small and deliberate: exactly 6 tips, 4 text and 2 audio, one flagged', () => {
    expect(SEED_BREADCRUMBS).toHaveLength(6);
    expect(SEED_BREADCRUMBS.map((b) => b.nickname).sort()).toEqual(
      ['fresh-audio', 'ignored-audio', 'ignored-old', 'middling', 'popular', 'popular-flagged'].sort(),
    );
    expect(SEED_BREADCRUMBS.filter((b) => b.kind === 'text')).toHaveLength(4);
    expect(SEED_BREADCRUMBS.filter((b) => b.kind === 'audio')).toHaveLength(2);
    expect(SEED_BREADCRUMBS.filter((b) => b.is_flagged).map((b) => b.nickname)).toEqual(['popular-flagged']);
    for (const b of SEED_BREADCRUMBS) {
      expect(b).not.toHaveProperty('hotspot');
      expect(b).not.toHaveProperty('layer');
    }
    const author = (nickname: string) => {
      const b = SEED_BREADCRUMBS.find((x) => x.nickname === nickname)!;
      return SEED_CONTRIBUTORS.find((c) => c.id === b.contributor_id)!;
    };
    expect(author('popular')).toMatchObject({ display_name: 'Coach Priya', has_loaf_badge: true });
    expect(author('popular-flagged').display_name).toBe('Big Rick');
    expect(author('fresh-audio')).toMatchObject({ display_name: 'Maya', has_loaf_badge: true });
    expect(author('ignored-audio')).toMatchObject({ display_name: 'Dev', has_loaf_badge: false });
    expect(author('ignored-old').display_name).toMatch(/^Guest/);
  });

  it('each audio seed stores its spoken script as the transcript', () => {
    const maya = SEED_BREADCRUMBS.find((b) => b.nickname === 'fresh-audio')!;
    const dev = SEED_BREADCRUMBS.find((b) => b.nickname === 'ignored-audio')!;
    expect(maya.body).toBe(MAYA_SCRIPT);
    expect(dev.body).toBe(DEV_SCRIPT);
    expect(MAYA_SCRIPT).toBe(
      "Hey, it's Maya. For the seated dumbbell shoulder press, sit tall with your back against the pad and a dumbbell in each hand at ear height. Press up slow and steady, breathe out as you go, keep your wrists stacked over your elbows, and take about two seconds coming back down. Lighter weight, better form.",
    );
    expect(DEV_SCRIPT).toBe(
      'Quick tip from Dev. I use this one as a warm-up. Grab light dumbbells, do ten quick reps, and keep your core tight so your back does not arch. Then go heavier for your real sets.',
    );
    expect(maya.audio_url).toBe('/audio/maya.mp3');
    expect(dev.audio_url).toBe('/audio/dev.mp3');
  });

  it('the generation script reads the very same words (so the mp3 and the transcript cannot drift apart)', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync('scripts/generate-audio.sh', 'utf8');
    expect(script).toContain(MAYA_SCRIPT);
    expect(script).toContain(DEV_SCRIPT);
    expect(script).toContain('en-US-AriaNeural');
    expect(script).toContain('en-US-GuyNeural');
    expect(script).toContain('public/audio/maya.mp3');
    expect(script).toContain('public/audio/dev.mp3');
  });
});

describe('ranking', () => {
  const base = { useful_count: 0, not_useful_count: 0, helped_count: 0, is_verified: false, is_flagged: false, has_loaf_badge: false };

  it('rewards freshness, useful votes and thanks', () => {
    expect(rankScore(base, 90)).toBeGreaterThan(rankScore(base, 40));
    expect(rankScore({ ...base, useful_count: 8 }, 50)).toBeGreaterThan(rankScore(base, 50));
    expect(rankScore({ ...base, helped_count: 8 }, 50)).toBeGreaterThan(rankScore(base, 50));
    expect(rankScore({ ...base, not_useful_count: 8 }, 50)).toBeLessThan(rankScore(base, 50));
  });

  it('gives verified and Loaf a modest boost and pushes flagged tips down', () => {
    const plain = rankScore(base, 50);
    expect(rankScore({ ...base, is_verified: true }, 50) - plain).toBe(DECAY.rank.verified);
    expect(rankScore({ ...base, has_loaf_badge: true }, 50) - plain).toBe(DECAY.rank.loaf);
    expect(rankScore({ ...base, is_flagged: true }, 50) - plain).toBe(DECAY.rank.flagged);
    // Modest: a Loaf badge alone cannot beat a clearly fresher tip.
    expect(rankScore({ ...base, has_loaf_badge: true }, 50)).toBeLessThan(rankScore(base, 60));
  });

  it('within a tab the flagged tip ranks below the trusted one, and ignored tips come last', () => {
    const scoreOf = (nickname: string) => {
      const b = SEED_BREADCRUMBS.find((crumb) => crumb.nickname === nickname)!;
      return rankScore(
        { ...b, has_loaf_badge: SEED_CONTRIBUTORS.find((c) => c.id === b.contributor_id)!.has_loaf_badge },
        freshnessAt(seeded(nickname), clock()),
      );
    };
    // Text tab: flagged is pushed down, not removed; it still outranks tips nobody reacted to.
    expect(scoreOf('popular')).toBeGreaterThan(scoreOf('popular-flagged'));
    expect(scoreOf('popular-flagged')).toBeGreaterThan(scoreOf('middling'));
    expect(scoreOf('middling')).toBeGreaterThan(scoreOf('ignored-old'));
    // Audio tab
    expect(scoreOf('fresh-audio')).toBeGreaterThan(scoreOf('ignored-audio'));
  });
});
