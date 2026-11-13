import { describe, expect, it } from 'vitest';
import { summarizeBehavior } from '../shared/behavior';
import type { DecayClock } from '../shared/decay';
import { SURVEY_KEYS, SURVEY_QUESTIONS, isValidAnswer, questionsFor } from '../shared/survey';
import {
  AUDIO_MAX_BYTES,
  AUDIO_MAX_SECONDS,
  AUDIO_MIME_TYPES,
  STARTER_PHRASES,
  TAGS,
  THANKS_MAX_LENGTH,
  THANKS_STARTERS,
  TIP_MAX_LENGTH,
  cleanTipText,
  normalizeTip,
  tipHash,
} from '../shared/text';
import { cleanMime, looksLike, readClip } from '../api/_lib/audio';
import type { Breadcrumb, BreadcrumbKind } from '../shared/types';
import { TOP_COUNT, clockLabel, liveCount, tabList } from '../src/lib/crumbs';

describe('near-duplicate merging by hash of normalized text', () => {
  it('ignores case, punctuation, spacing and filler words', () => {
    const a = tipHash('Keep your wrists stacked over your elbows.');
    expect(tipHash('keep wrists stacked over elbows')).toBe(a);
    expect(tipHash('  KEEP YOUR WRISTS   STACKED over your elbows!!! ')).toBe(a);
  });

  it('keeps different tips apart', () => {
    expect(tipHash('Keep your wrists stacked over your elbows.')).not.toBe(tipHash('Breathe out as you press.'));
  });

  it('cleans control characters and collapses whitespace', () => {
    expect(cleanTipText('  hello\n\tworld\u0000 ')).toBe('hello world');
    expect(normalizeTip('The  Seat, please!')).toBe('seat');
  });
});

describe('limits and starter phrases', () => {
  it('starter phrases fit in a tip, and the three thank-you starters fit in a note', () => {
    expect(STARTER_PHRASES.length).toBeGreaterThanOrEqual(3);
    for (const phrase of STARTER_PHRASES) expect(phrase.length).toBeLessThanOrEqual(TIP_MAX_LENGTH);
    expect(TIP_MAX_LENGTH).toBe(140);
    expect(THANKS_STARTERS).toHaveLength(3);
    expect(THANKS_MAX_LENGTH).toBe(80);
    for (const phrase of THANKS_STARTERS) expect(phrase.length).toBeLessThanOrEqual(THANKS_MAX_LENGTH);
  });

  it('the filter chips are For beginners and Fixing my wrist', () => {
    expect(TAGS.map((t) => t.label)).toEqual(['For beginners', 'Fixing my wrist']);
  });

  it('recordings are capped at 20 seconds and 1 MB, in the formats phones record', () => {
    expect(AUDIO_MAX_SECONDS).toBe(20);
    expect(AUDIO_MAX_BYTES).toBe(1024 * 1024);
    expect(AUDIO_MIME_TYPES).toEqual(expect.arrayContaining(['audio/mp4', 'audio/webm'])); // iPhone Safari, Chrome
  });
});

describe('audio upload validation', () => {
  const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array(64).fill(1)]);
  const ftyp = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70);
  const ebml = bytes(0x1a, 0x45, 0xdf, 0xa3);

  it('strips the codecs suffix and refuses anything that is not a recording format', () => {
    expect(cleanMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(cleanMime('audio/mp4; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(cleanMime('AUDIO/MP4')).toBe('audio/mp4');
    expect(cleanMime('audio/x-m4a')).toBe('audio/mp4');
    for (const bad of ['video/mp4', 'text/html', 'audio/wav', 'application/javascript', '']) expect(() => cleanMime(bad), bad).toThrow();
  });

  it('checks the first bytes of the file against the declared type', () => {
    expect(looksLike('audio/mp4', ftyp)).toBe(true);
    expect(looksLike('audio/webm', ebml)).toBe(true);
    expect(looksLike('audio/ogg', bytes(0x4f, 0x67, 0x67, 0x53))).toBe(true);
    expect(looksLike('audio/mpeg', bytes(0x49, 0x44, 0x33))).toBe(true);
    expect(looksLike('audio/mpeg', bytes(0xff, 0xfb))).toBe(true);
    expect(looksLike('audio/aac', bytes(0xff, 0xf1))).toBe(true);
    expect(looksLike('audio/webm', ftyp)).toBe(false);
    expect(looksLike('audio/mp4', ebml)).toBe(false);
    expect(looksLike('audio/webm', bytes(0x3c, 0x68, 0x74, 0x6d))).toBe(false); // "<htm"
  });

  it('decodes a good clip and refuses empty, oversized and malformed ones', () => {
    const good = Buffer.from(ebml).toString('base64');
    const clip = readClip(good, 'audio/webm;codecs=opus');
    expect(clip.mime).toBe('audio/webm');
    expect(clip.bytes.length).toBe(ebml.length);
    expect(() => readClip('', 'audio/webm')).toThrow();
    expect(() => readClip('@@@', 'audio/webm')).toThrow();
    expect(() => readClip(Buffer.alloc(AUDIO_MAX_BYTES + 1, 1).toString('base64'), 'audio/webm')).toThrow(/too large/);
    expect(() => readClip('A'.repeat(4_000_000), 'audio/webm')).toThrow(/too large/);
  });
});

describe('crowd control: top 3 per tab, See more, filters, new tips on top, faded tips hidden', () => {
  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const clock: DecayClock = { nowMs: NOW, busyness: 'normal', multiplier: 1, skipActive: false };
  let n = 0;
  const crumb = (kind: BreadcrumbKind, patch: Partial<Breadcrumb> & { loaf?: boolean } = {}): Breadcrumb => {
    n += 1;
    const { loaf, ...rest } = patch;
    return {
      id: `id-${n}`,
      station_id: 's',
      kind,
      body: `tip ${n}`,
      audio_url: null,
      audio_seconds: null,
      contributor_id: `c-${n}`,
      base_freshness: 100,
      last_interaction_at: new Date(NOW).toISOString(),
      created_at: new Date(NOW - 30 * 86_400_000).toISOString(),
      is_verified: false,
      is_flagged: false,
      helped_count: 0,
      useful_count: 0,
      not_useful_count: 0,
      rank_score: 0,
      tags: [],
      text_hash: `h-${n}`,
      pin_state: 'none',
      duplicate_count: 1,
      contributor: { id: `c-${n}`, display_name: `Person ${n}`, has_loaf_badge: Boolean(loaf), is_seeded: true },
      my_vote: null,
      my_helped: false,
      my_note: null,
      thanks_notes: null,
      ...rest,
    };
  };
  const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

  it('shows the best 3 of a tab and keeps the rest behind See more', () => {
    const crumbs = [
      crumb('text', { body: 'plain' }),
      crumb('text', { body: 'voted', useful_count: 9, helped_count: 4 }),
      crumb('text', { body: 'loaf', loaf: true }),
      crumb('text', { body: 'verified', is_verified: true }),
      crumb('text', { body: 'older', last_interaction_at: daysAgo(5) }),
      crumb('audio', { body: 'other tab', useful_count: 50 }),
    ];
    const list = tabList(crumbs, clock, 'text', null, null);
    expect(TOP_COUNT).toBe(3);
    expect(list.top.map((v) => v.crumb.body)).toEqual(['voted', 'verified', 'loaf']);
    expect(list.more.map((v) => v.crumb.body)).toEqual(['plain', 'older']);
    expect(list.total).toBe(5); // the audio tip is not in the Text list
  });

  it('a flagged tip is ranked lower but still listed', () => {
    const crumbs = [
      crumb('text', { body: 'flagged favorite', useful_count: 6, helped_count: 6, is_flagged: true }),
      crumb('text', { body: 'clean', useful_count: 5, helped_count: 5 }),
    ];
    const list = tabList(crumbs, clock, 'text', null, null);
    expect(list.top.map((v) => v.crumb.body)).toEqual(['clean', 'flagged favorite']);
  });

  it('tips that have faded away leave the list and the count, but are not deleted', () => {
    const crumbs = [crumb('text', { body: 'fresh' }), crumb('text', { body: 'ancient', last_interaction_at: daysAgo(60) })];
    const list = tabList(crumbs, clock, 'text', null, null);
    expect(list.top.map((v) => v.crumb.body)).toEqual(['fresh']);
    expect(list.gone.map((v) => v.crumb.body)).toEqual(['ancient']);
    expect(liveCount(crumbs, clock, 'text')).toBe(1);
    expect(liveCount(crumbs, clock, 'audio')).toBe(0);
    expect(liveCount(crumbs, clock)).toBe(1);
    expect(crumbs).toHaveLength(2);
  });

  it('filter chips narrow by tag, and a just-posted tip can be pinned first', () => {
    const crumbs = [
      crumb('text', { body: 'a', tags: ['for-beginners'], useful_count: 9 }),
      crumb('text', { body: 'b', tags: ['fixing-my-wrist'] }),
      crumb('text', { body: 'c' }),
    ];
    expect(tabList(crumbs, clock, 'text', 'fixing-my-wrist', null).top.map((v) => v.crumb.body)).toEqual(['b']);
    expect(tabList(crumbs, clock, 'text', null, crumbs[2].id).top[0].crumb.body).toBe('c');
  });

  it('a tip a participant posted minutes ago floats to the top so the live loop is visible', () => {
    const fresh = crumb('audio', { body: 'just posted', created_at: new Date(NOW - 60_000).toISOString() });
    fresh.contributor.is_seeded = false;
    const crumbs = [crumb('audio', { body: 'popular', useful_count: 20, helped_count: 20, loaf: true, is_verified: true }), fresh];
    const list = tabList(crumbs, clock, 'audio', null, null);
    expect(list.top[0].crumb.body).toBe('just posted');
    expect(list.top[0].isNew).toBe(true);
  });

  it('each tab lists only its own kind', () => {
    const crumbs = [crumb('text', { body: 't' }), crumb('audio', { body: 'a1' }), crumb('audio', { body: 'a2' })];
    expect(tabList(crumbs, clock, 'text', null, null).top.map((v) => v.crumb.body)).toEqual(['t']);
    expect(tabList(crumbs, clock, 'audio', null, null).total).toBe(2);
  });

  it('formats clip lengths', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(7.4)).toBe('0:07');
    expect(clockLabel(20)).toBe('0:20');
    expect(clockLabel(75)).toBe('1:15');
  });
});

describe('survey', () => {
  const NONE = { posted: false, playedAudio: false };
  const BOTH = { posted: true, playedAudio: true };
  const keysFor = (baseline: boolean, facts: { posted: boolean; playedAudio: boolean }) => questionsFor(baseline, facts).map((q) => q.key);

  it('has unique keys and no duplicate questions', () => {
    expect(new Set(SURVEY_QUESTIONS.map((q) => q.key)).size).toBe(SURVEY_QUESTIONS.length);
    expect(new Set(SURVEY_QUESTIONS.map((q) => q.prompt)).size).toBe(SURVEY_QUESTIONS.length);
  });

  it('is about 4 minutes: 13 or 14 screens depending on what the participant did', () => {
    expect(questionsFor(false, NONE)).toHaveLength(13);
    expect(questionsFor(false, { posted: false, playedAudio: true })).toHaveLength(13);
    expect(questionsFor(false, { posted: true, playedAudio: false })).toHaveLength(14);
    expect(questionsFor(false, BOTH)).toHaveLength(14);
  });

  it('asks nothing about the ghost, hologram, layers, form colors, tracking, hotspots, the camera flip or roles', () => {
    const text = JSON.stringify(SURVEY_QUESTIONS).toLowerCase();
    for (const word of [
      'ghost',
      'hologram',
      'layer',
      'color',
      'joint',
      'skeleton',
      'tracking',
      'follow along',
      'hotspot',
      'flip',
      'novice',
      'expert ',
    ]) {
      expect(text, word).not.toContain(word);
    }
  });

  it('asks what a faded tip means before any question mentions time passing', () => {
    const keys = keysFor(false, NONE);
    expect(keys.indexOf('faded_meaning')).toBeGreaterThan(-1);
    expect(keys.indexOf('faded_meaning')).toBeLessThan(keys.indexOf('skip_reaction'));
    const before = questionsFor(false, BOTH).slice(0, keysFor(false, BOTH).indexOf('faded_meaning') + 1);
    expect(JSON.stringify(before).toLowerCase()).not.toMatch(/stale|old|time|week|decay|later/);
  });

  it('covers every required topic, in one fixed order', () => {
    expect(keysFor(false, NONE)).toEqual([
      'gym_comfort',
      'gym_experience',
      'first_tab',
      'glasses_natural',
      'faded_meaning',
      'skip_reaction',
      'trust',
      'badge_or_warning',
      'helped_count',
      'not_posted_why',
      'audio_why_not',
      'most_confusing',
      'one_change',
    ]);
    expect(SURVEY_KEYS).toEqual(expect.arrayContaining(['trust_why', 'first_tab_why', 'badge_or_warning_why', 'audio_vs_reading_why']));
  });

  it('asks about self-reported experience with exactly three levels', () => {
    const q = SURVEY_QUESTIONS.find((x) => x.key === 'gym_experience')!;
    expect(q.prompt).toBe('How experienced are you in a gym?');
    expect(q.options!.map((o) => o.label)).toEqual(['Brand new', 'Some experience', 'Experienced']);
    expect(q.options!.map((o) => o.value)).toEqual(['brand_new', 'some_experience', 'experienced']);
  });

  it('the first-tab question offers Text and Audio, with values that match the logged tab names', () => {
    const q = SURVEY_QUESTIONS.find((x) => x.key === 'first_tab')!;
    expect(q.options!.map((o) => o.value)).toEqual(['text', 'audio', 'not_sure']);
    expect(q.followUp).toBeTruthy(); // "and why"
  });

  it('follow-ups depend on behavior: posted or not, played audio or not', () => {
    const posted = keysFor(false, { posted: true, playedAudio: false });
    expect(posted).toEqual(expect.arrayContaining(['posted_why', 'posted_ease', 'audio_why_not']));
    expect(posted).not.toContain('not_posted_why');
    expect(posted).not.toContain('audio_vs_reading');
    const listened = keysFor(false, { posted: false, playedAudio: true });
    expect(listened).toEqual(expect.arrayContaining(['not_posted_why', 'audio_vs_reading']));
    expect(listened).not.toContain('posted_why');
    expect(listened).not.toContain('audio_why_not');
    // Nobody is asked both sides of a branch.
    for (const facts of [NONE, BOTH]) {
      const keys = keysFor(false, facts);
      expect(keys.includes('posted_why') && keys.includes('not_posted_why')).toBe(false);
      expect(keys.includes('audio_vs_reading') && keys.includes('audio_why_not')).toBe(false);
    }
  });

  it('the plain-text baseline drops everything it has nothing to ask about', () => {
    const keys = keysFor(true, NONE);
    for (const key of [
      'first_tab',
      'glasses_natural',
      'faded_meaning',
      'skip_reaction',
      'badge_or_warning',
      'helped_count',
      'posted_why',
      'not_posted_why',
      'audio_vs_reading',
      'audio_why_not',
    ])
      expect(keys, key).not.toContain(key);
    expect(keys).toEqual(['gym_comfort', 'gym_experience', 'trust', 'most_confusing', 'one_change']);
  });

  it('validates answers by question type', () => {
    expect(isValidAnswer('gym_comfort', '3')).toBe(true);
    expect(isValidAnswer('gym_comfort', '6')).toBe(false);
    expect(isValidAnswer('first_tab', 'audio')).toBe(true);
    expect(isValidAnswer('first_tab', 'hologram')).toBe(false);
    expect(isValidAnswer('gym_experience', 'some_experience')).toBe(true);
    expect(isValidAnswer('faded_meaning', 'nobody uses it any more')).toBe(true);
    expect(isValidAnswer('faded_meaning', '')).toBe(false);
    expect(isValidAnswer('trust_why', 'the badge')).toBe(true);
    expect(isValidAnswer('made_up_key', 'x')).toBe(false);
    expect(isValidAnswer('faded_meaning', 'x'.repeat(601))).toBe(false);
  });
});

describe('behavior summary', () => {
  const ev = (event_type: string, metadata: Record<string, unknown> = {}, breadcrumb_id: string | null = null) => ({
    event_type,
    metadata,
    breadcrumb_id,
  });

  it('folds an event stream into the columns used by the results view and CSV', () => {
    const s = summarizeBehavior([
      ev('session_started', { group: 'novice' }),
      ev('panel_opened', {}),
      ev('tab_opened', { tab: 'audio', first: true }),
      ev('tip_viewed', { kind: 'audio', loaf: true }, 'a'),
      ev('tip_viewed', { kind: 'audio' }, 'b'),
      ev('audio_started', { mode: 'file' }, 'a'),
      ev('audio_stopped', { listened_ms: 8_400, completed: false }, 'a'),
      ev('audio_started', { mode: 'speech' }, 'b'),
      ev('audio_stopped', { listened_ms: 14_200, completed: true }, 'b'),
      ev('transcript_opened', {}, 'a'),
      ev('vote_cast', { value: 'useful', kind: 'audio', loaf: true }, 'a'),
      ev('helped_marked', { kind: 'audio', loaf: true }, 'a'),
      ev('thanks_note_sent', { kind: 'audio', length: 20 }, 'a'),
      ev('tab_closed', { tab: 'audio', duration_ms: 30_000 }),
      ev('tab_opened', { tab: 'text' }),
      ev('tip_viewed', { kind: 'text', flagged: true }, 'c'),
      ev('tip_viewed', { kind: 'text', flagged: true }, 'c'), // the same tip again is still one tip
      ev('vote_cast', { value: 'not_useful', kind: 'text', flagged: true }, 'c'),
      ev('see_more_opened', { tab: 'text' }),
      ev('filter_used', { tag: 'for-beginners', tab: 'text' }),
      ev('tab_closed', { tab: 'text', duration_ms: 3_000 }),
      ev('tab_opened', { tab: 'audio' }),
      ev('tab_closed', { tab: 'audio', duration_ms: 1_000 }),
      ev('time_skip_seen', { seconds: 604_800, source: 'scripted' }),
      ev('breadcrumb_faded', { label: 'Seat pin on hole 4', state: 'gone' }, 'd'),
      ev('breadcrumb_added', { kind: 'audio', shape: 'recorded', merged: false }, 'e'),
      ev('breadcrumb_added', { kind: 'text', shape: 'typed', merged: false }, 'f'),
    ]);
    expect(s.first_tab).toBe('audio');
    expect(s.tabs_opened).toEqual(['audio', 'text']);
    expect(s.tab_view_ms).toEqual({ audio: 31_000, text: 3_000 });
    expect(s.tips_viewed).toBe(3);
    expect(s.audio_plays).toBe(2);
    expect(s.audio_listened_seconds).toBe(23); // 8.4 s + 14.2 s
    expect(s.audio_completed).toBe(1);
    expect(s.transcripts_opened).toBe(1);
    expect(s.votes_cast).toBe(2);
    expect(s.thanks_sent).toBe(1);
    expect(s.thanks_notes_sent).toBe(1);
    expect(s.see_more_used).toBe(true);
    expect(s.filter_used).toBe(true);
    expect(s.tips_added).toBe(2);
    expect(s.added_kinds).toEqual(['audio', 'text']);
    expect(s.reacted_to_loaf).toBe(true);
    expect(s.reacted_to_flagged).toBe(true);
    expect(s.time_skip_seen).toBe(true);
    expect(s.faded_breadcrumbs).toEqual(['Seat pin on hole 4']);
  });

  it('picking the All chip does not count as using a filter', () => {
    expect(summarizeBehavior([ev('filter_used', { tag: 'all', tab: 'text' })]).filter_used).toBe(false);
  });

  it('an empty log gives an empty summary', () => {
    const s = summarizeBehavior([]);
    expect(s.first_tab).toBeNull();
    expect(s.tabs_opened).toEqual([]);
    expect(s.audio_plays).toBe(0);
    expect(s.audio_listened_seconds).toBe(0);
    expect(s.tips_added).toBe(0);
    expect(s.time_skip_seen).toBe(false);
  });
});
