/**
 * Seed content for the one station in this prototype: the seated dumbbell shoulder press.
 *
 * Exactly six breadcrumbs, so there is room for participants to add their own.
 * The mix is deliberate (see README "The seed, and what each time-skip does to it"):
 *   - popular          text   Coach Priya, Loaf + Verified: stays bright after a week
 *   - popular-flagged  text   Big Rick: keeps its warning label while it decays
 *   - ignored-old      text   Guest 3: already stale, gone after a one-week skip
 *   - middling         text   Tomás: dims after a week, stale after a month
 *   - fresh-audio      audio  Maya, Loaf + Verified
 *   - ignored-audio    audio  Dev: old, nobody reacted, fading
 *
 * Ages are stored as "hours ago" and turned into timestamps when the seed is
 * applied, so the demo starts in the same state no matter what day it is run.
 * The same data is bundled into the app as the offline fallback.
 */
import { tipHash } from './text.js';
import type { BreadcrumbKind } from './types.js';

export const STATION = {
  id: '5f0c1a52-7d0e-4c8e-9a51-000000000001',
  name: 'Seated dumbbell shoulder press',
  code: 'shoulder-press',
};

export interface SeedContributor {
  id: string;
  display_name: string;
  has_loaf_badge: boolean;
}

export const SEED_CONTRIBUTORS: SeedContributor[] = [
  { id: 'c0000000-0000-4000-8000-000000000001', display_name: 'Coach Priya', has_loaf_badge: true },
  { id: 'c0000000-0000-4000-8000-000000000002', display_name: 'Maya', has_loaf_badge: true },
  { id: 'c0000000-0000-4000-8000-000000000003', display_name: 'Dev', has_loaf_badge: false },
  { id: 'c0000000-0000-4000-8000-000000000004', display_name: 'Tomás', has_loaf_badge: false },
  { id: 'c0000000-0000-4000-8000-000000000005', display_name: 'Big Rick', has_loaf_badge: false },
  { id: 'c0000000-0000-4000-8000-000000000006', display_name: 'Guest 3', has_loaf_badge: false },
];

/** Participants are named "Guest N" starting here, after the seeded Guest 3. */
export const FIRST_GUEST_NUMBER = 4;

/**
 * The two seeded audio tips. Each script is stored as the transcript. The mp3 files are made once,
 * at build time, by scripts/generate-audio.sh (edge-tts). If a file is missing, the app reads the
 * transcript aloud with the phone's own voice instead.
 */
export const MAYA_SCRIPT =
  "Hey, it's Maya. For the seated dumbbell shoulder press, sit tall with your back against the pad and a dumbbell in each hand at ear height. Press up slow and steady, breathe out as you go, keep your wrists stacked over your elbows, and take about two seconds coming back down. Lighter weight, better form.";
export const DEV_SCRIPT =
  'Quick tip from Dev. I use this one as a warm-up. Grab light dumbbells, do ten quick reps, and keep your core tight so your back does not arch. Then go heavier for your real sets.';

export interface SeedBreadcrumb {
  id: string;
  kind: BreadcrumbKind;
  /** The tip text, or the transcript of an audio tip. */
  body: string;
  audio_url: string | null;
  audio_seconds: number | null;
  contributor_id: string;
  tags: string[];
  is_verified: boolean;
  is_flagged: boolean;
  useful_count: number;
  not_useful_count: number;
  helped_count: number;
  base_freshness: number;
  /** Hours before "now" of the last vote / thanks. */
  lastInteractionHoursAgo: number;
  createdHoursAgo: number;
  /** Short name used in logs, tests and the README table. */
  nickname: string;
}

const DAY = 24;

export const SEED_BREADCRUMBS: SeedBreadcrumb[] = [
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    nickname: 'popular',
    kind: 'text',
    body: 'Stack your wrists right over your elbows the whole way up.',
    audio_url: null,
    audio_seconds: null,
    contributor_id: SEED_CONTRIBUTORS[0].id,
    tags: ['for-beginners', 'fixing-my-wrist'],
    is_verified: true,
    is_flagged: false,
    useful_count: 14,
    not_useful_count: 1,
    helped_count: 12,
    base_freshness: 100,
    lastInteractionHoursAgo: 2,
    createdHoursAgo: 20 * DAY,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    nickname: 'middling',
    kind: 'text',
    body: 'Start lighter than you think. Smooth reps first.',
    audio_url: null,
    audio_seconds: null,
    contributor_id: SEED_CONTRIBUTORS[3].id,
    tags: ['for-beginners'],
    is_verified: false,
    is_flagged: false,
    useful_count: 3,
    not_useful_count: 2,
    helped_count: 0,
    base_freshness: 100,
    lastInteractionHoursAgo: 9.5 * DAY,
    createdHoursAgo: 30 * DAY,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    nickname: 'ignored-old',
    kind: 'text',
    body: 'I set the bench back one notch from fully upright.',
    audio_url: null,
    audio_seconds: null,
    contributor_id: SEED_CONTRIBUTORS[5].id,
    tags: [],
    is_verified: false,
    is_flagged: false,
    useful_count: 0,
    not_useful_count: 0,
    helped_count: 0,
    base_freshness: 100,
    lastInteractionHoursAgo: 13 * DAY,
    createdHoursAgo: 13 * DAY,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000004',
    nickname: 'popular-flagged',
    kind: 'text',
    body: 'Lock your elbows out hard at the top of every rep.',
    audio_url: null,
    audio_seconds: null,
    contributor_id: SEED_CONTRIBUTORS[4].id,
    tags: [],
    is_verified: false,
    is_flagged: true,
    useful_count: 11,
    not_useful_count: 4,
    helped_count: 9,
    base_freshness: 100,
    lastInteractionHoursAgo: 1 * DAY,
    createdHoursAgo: 25 * DAY,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000005',
    nickname: 'fresh-audio',
    kind: 'audio',
    body: MAYA_SCRIPT,
    audio_url: '/audio/maya.mp3',
    audio_seconds: 20,
    contributor_id: SEED_CONTRIBUTORS[1].id,
    tags: ['for-beginners', 'fixing-my-wrist'],
    is_verified: true,
    is_flagged: false,
    useful_count: 9,
    not_useful_count: 0,
    helped_count: 15,
    base_freshness: 100,
    lastInteractionHoursAgo: 5,
    createdHoursAgo: 14 * DAY,
  },
  {
    id: 'b0000000-0000-4000-8000-000000000006',
    nickname: 'ignored-audio',
    kind: 'audio',
    body: DEV_SCRIPT,
    audio_url: '/audio/dev.mp3',
    audio_seconds: 15,
    contributor_id: SEED_CONTRIBUTORS[2].id,
    tags: [],
    is_verified: false,
    is_flagged: false,
    useful_count: 0,
    not_useful_count: 0,
    helped_count: 0,
    base_freshness: 100,
    lastInteractionHoursAgo: 8 * DAY,
    createdHoursAgo: 31 * DAY,
  },
];

export function seedTextHash(crumb: SeedBreadcrumb): string {
  return tipHash(crumb.body);
}

/** Warning shown on a popular tip that trainers dispute. The tip is labelled and ranked lower, never deleted. */
export const FLAG_WARNING = 'Popular, but trainers suggest a soft bend at the top instead.';
