/**
 * API route tests. Each route handler is called directly against a throwaway
 * in-memory Postgres (PGlite) that has run the real migrations and seed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import adminActions from '../api/admin/actions';
import adminLogin from '../api/admin/login';
import adminResults, { csvCell } from '../api/admin/results';
import audio from '../api/audio';
import breadcrumbs from '../api/breadcrumbs';
import events from '../api/events';
import helped from '../api/helped';
import sessions from '../api/sessions';
import state from '../api/state';
import stations from '../api/stations';
import survey from '../api/survey';
import votes from '../api/votes';
import { verifyToken } from '../api/_lib/auth';
import type { Db } from '../api/_lib/db';
import { resetRateLimits } from '../api/_lib/http';
import { applySeed } from '../api/_lib/seed';
import { DAY_SECONDS, DECAY, SCRIPTED_SKIP_SECONDS, freshnessAt, freshnessState, virtualNowMs } from '../shared/decay';
import { DEV_SCRIPT, MAYA_SCRIPT, SEED_BREADCRUMBS, STATION } from '../shared/seed';
import type { AdminOverview, Breadcrumb, BreadcrumbsResponse, ResultsResponse, SessionInfo, StateResponse } from '../shared/types';
import { startLocalDb } from '../scripts/local-db';
import { call } from './helpers';

/** Small stand-in clips: the right file header for each format, then filler. No real sound is needed to test the route. */
const clip = (header: number[], size = 2000) => Buffer.concat([Buffer.from(header), Buffer.alloc(size, 7)]).toString('base64');
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const MP4 = [0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]; // ....ftyp

let db: Db;
let close: () => Promise<void>;
let token: string;

const id = (nickname: string) => SEED_BREADCRUMBS.find((b) => b.nickname === nickname)!.id;

async function newSession(group: string | null = null, baseline = false): Promise<SessionInfo> {
  const res = await call<SessionInfo>(sessions, { method: 'POST', body: { group, baseline } });
  expect(res.status).toBe(200);
  return res.json;
}

async function list(sessionId?: string, extra = ''): Promise<Breadcrumb[]> {
  const res = await call<BreadcrumbsResponse>(breadcrumbs, {
    url: `/api/breadcrumbs?station=${STATION.code}${sessionId ? `&session_id=${sessionId}` : ''}${extra}`,
  });
  expect(res.status).toBe(200);
  return res.json.breadcrumbs;
}

async function admin(body: Record<string, unknown>): Promise<AdminOverview> {
  const res = await call<AdminOverview>(adminActions, { method: 'POST', body, token });
  expect(res.status).toBe(200);
  return res.json;
}

beforeAll(async () => {
  process.env.ADMIN_PIN = '4321';
  delete process.env.DATABASE_URL;
  ({ db, close } = await startLocalDb());
  const login = await call<{ token: string }>(adminLogin, { method: 'POST', body: { pin: '4321' } });
  token = login.json.token;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  resetRateLimits();
  // Back to the seeded starting state between tests.
  await db.query('delete from breadcrumbs where not is_seeded');
  await db.query('delete from audio_clips');
  await db.query(
    `update settings set virtual_clock_offset_seconds = 0, gym_busyness = 'normal', decay_multiplier = 1, auto_skip_enabled = true`,
  );
  await applySeed(db, { restore: true });
});

describe('seed and read routes', () => {
  it('finds the one station by its QR code', async () => {
    const res = await call(stations, { url: `/api/stations?code=${STATION.code}` });
    expect(res.json.station.name).toBe('Seated dumbbell shoulder press');
    expect(res.json.hotspots).toBeUndefined();
    expect((await call(stations, { url: '/api/stations?code=nope' })).status).toBe(404);
    expect((await call(stations, { url: '/api/stations?code=DROP%20TABLE' })).status).toBe(400);
  });

  it('lists exactly the 6 seeded breadcrumbs: 4 text and 2 audio, best-first within each kind', async () => {
    const crumbs = await list();
    expect(crumbs).toHaveLength(6);
    const of = (kind: string) => crumbs.filter((b) => b.kind === kind);
    // Text: the trusted tip first; the popular-but-flagged one below it; the old ignored one last.
    expect(of('text').map((b) => b.id)).toEqual([id('popular'), id('popular-flagged'), id('middling'), id('ignored-old')]);
    expect(of('audio').map((b) => b.id)).toEqual([id('fresh-audio'), id('ignored-audio')]);
    for (const kind of ['text', 'audio']) {
      const rows = of(kind);
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1].rank_score).toBeGreaterThanOrEqual(rows[i].rank_score);
    }
    const popular = crumbs.find((b) => b.id === id('popular'))!;
    expect(popular.body).toBe('Stack your wrists right over your elbows the whole way up.');
    expect(popular.contributor.display_name).toBe('Coach Priya');
    expect(popular.contributor.has_loaf_badge).toBe(true);
    expect(popular.is_verified).toBe(true);
    expect(popular.helped_count).toBe(12);
    const flagged = crumbs.find((b) => b.id === id('popular-flagged'))!;
    expect(flagged.body).toBe('Lock your elbows out hard at the top of every rep.');
    expect(flagged.contributor.display_name).toBe('Big Rick');
    expect(flagged.is_flagged).toBe(true);
    expect(flagged.helped_count).toBe(9);
    const ignored = crumbs.find((b) => b.id === id('ignored-old'))!;
    expect(ignored.useful_count + ignored.not_useful_count + ignored.helped_count).toBe(0);
    // Text tips carry no audio fields.
    expect(of('text').every((b) => b.audio_url === null && b.audio_seconds === null)).toBe(true);
    // Nobody is given thank-you notes that are not theirs.
    expect(crumbs.every((b) => b.thanks_notes === null && b.my_note === null)).toBe(true);
  });

  it('the two audio tips carry their scripts as transcripts and point at the generated mp3 files', async () => {
    const crumbs = await list();
    const maya = crumbs.find((b) => b.id === id('fresh-audio'))!;
    const dev = crumbs.find((b) => b.id === id('ignored-audio'))!;
    expect(maya.contributor.display_name).toBe('Maya');
    expect(maya.contributor.has_loaf_badge).toBe(true);
    expect(maya.is_verified).toBe(true);
    expect(maya.body).toBe(MAYA_SCRIPT);
    expect(maya.body.startsWith("Hey, it's Maya. For the seated dumbbell shoulder press,")).toBe(true);
    expect(maya.audio_url).toBe('/audio/maya.mp3');
    expect(dev.contributor.display_name).toBe('Dev');
    expect(dev.body).toBe(DEV_SCRIPT);
    expect(dev.body.startsWith('Quick tip from Dev. I use this one as a warm-up.')).toBe(true);
    expect(dev.audio_url).toBe('/audio/dev.mp3');
    expect(dev.helped_count).toBe(0);
  });

  it('returns one kind, and only its top N, when asked (indexed LIMIT)', async () => {
    const audioOnly = await list(undefined, '&kind=audio');
    expect(audioOnly.map((b) => b.id)).toEqual([id('fresh-audio'), id('ignored-audio')]);
    const top = await list(undefined, '&kind=text&limit=1');
    expect(top.map((b) => b.id)).toEqual([id('popular')]);
    expect((await call(breadcrumbs, { url: `/api/breadcrumbs?station=${STATION.code}&limit=9999` })).status).toBe(400);
    expect((await call(breadcrumbs, { url: `/api/breadcrumbs?station=${STATION.code}&kind=hologram` })).status).toBe(400);
  });

  it('has the ranking and duplicate indexes on (station, kind, ...), and nothing left of ghosts, layers, hotspots or roles', async () => {
    const indexes = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'breadcrumbs'");
    expect(indexes.some((i) => /station_id, kind, rank_score DESC/.test(i.indexdef))).toBe(true);
    expect(indexes.some((i) => /station_id, kind, text_hash/.test(i.indexdef))).toBe(true);
    const columns = async (table: string) =>
      (await db.query<{ column_name: string }>('select column_name from information_schema.columns where table_name = $1', [table])).map(
        (c) => c.column_name,
      );
    const crumbColumns = await columns('breadcrumbs');
    for (const kept of ['kind', 'body', 'audio_url', 'audio_seconds']) expect(crumbColumns).toContain(kept);
    for (const gone of ['layer', 'hotspot', 'ghost_id']) expect(crumbColumns).not.toContain(gone);
    const sessionColumns = await columns('sessions');
    expect(sessionColumns).toContain('group_tag');
    for (const gone of ['role', 'feedback_mode']) expect(sessionColumns).not.toContain(gone);
    const tables = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).map(
      (t) => t.tablename,
    );
    expect(tables).not.toContain('ghosts');
    expect(tables).toContain('audio_clips');
  });

  it('the database refuses a breadcrumb of an unknown kind, a text tip with audio fields, and an empty tip', async () => {
    const insert = (kind: string | null, body: string, audioUrl: string | null) =>
      db.query(
        `insert into breadcrumbs (station_id, kind, body, audio_url, contributor_id, text_hash)
         select $1::uuid, $2, $3, $4, id, 'h' from contributors limit 1`,
        [STATION.id, kind, body, audioUrl],
      );
    await expect(insert('hologram', 'x', null)).rejects.toThrow();
    await expect(insert(null, 'x', null)).rejects.toThrow();
    await expect(insert('text', 'x', '/audio/x.mp3')).rejects.toThrow();
    await expect(insert('text', '', null)).rejects.toThrow();
    await expect(insert('audio', '', null)).rejects.toThrow(); // audio needs a clip or words to read aloud
  });
});

describe('sessions: anonymous, no roles', () => {
  it('creates an anonymous session with a friendly guest name and no role', async () => {
    const a = await newSession();
    const b = await newSession();
    expect(a).not.toHaveProperty('role');
    expect(a.group).toBeNull();
    expect(a.prototype_version).toBe('session_1');
    expect(a.contributor.display_name).toMatch(/^Guest \d+$/);
    expect(b.contributor.display_name).toMatch(/^Guest \d+$/);
    expect(b.contributor.display_name).not.toBe(a.contributor.display_name);
    expect(Number(a.contributor.display_name.slice(6))).toBeGreaterThanOrEqual(4); // "Guest 3" is a seeded author
    expect(a.contributor.has_loaf_badge).toBe(false);
  });

  it('an optional group tag from the link is stored silently; junk tags are refused', async () => {
    const novice = await newSession('novice');
    const expert = await newSession('expert');
    expect(novice.group).toBe('novice');
    expect(expert.group).toBe('expert');
    const rows = await db.query<{ group_tag: string }>('select group_tag from sessions where id = $1::uuid', [novice.id]);
    expect(rows[0].group_tag).toBe('novice');
    for (const bad of ['Has Spaces', '<script>', 'x'.repeat(25), "a'; drop table sessions; --"]) {
      expect((await call(sessions, { method: 'POST', body: { group: bad } })).status, bad).toBe(400);
    }
  });

  it('a group tag changes nothing about what a participant may do, and a client-sent role is ignored', async () => {
    const tagged = await newSession('novice');
    const res = await call(breadcrumbs, {
      method: 'POST',
      body: { session_id: tagged.id, station: STATION.code, kind: 'text', body: 'Anyone can leave a tip.', role: 'expert' },
    });
    expect(res.status).toBe(200);
    expect(res.json.breadcrumb.contributor.display_name).toBe(tagged.contributor.display_name);
    const withRole = await call<SessionInfo>(sessions, { method: 'POST', body: { role: 'admin' } });
    expect(withRole.status).toBe(200);
    expect(withRole.json).not.toHaveProperty('role');
  });
});

describe('voting', () => {
  it('counts a useful vote, raises freshness and refreshes the stored rank', async () => {
    const s = await newSession();
    const before = (await list(s.id)).find((b) => b.id === id('ignored-old'))!;
    const res = await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: before.id, value: 'useful' } });
    expect(res.status).toBe(200);
    const after: Breadcrumb = res.json.breadcrumb;
    expect(after.useful_count).toBe(before.useful_count + 1);
    expect(after.my_vote).toBe('useful');
    expect(after.base_freshness).toBeGreaterThan(30);
    expect(after.rank_score).toBeGreaterThan(before.rank_score);
    expect(Date.parse(after.last_interaction_at)).toBeGreaterThan(Date.parse(before.last_interaction_at));
  });

  it('is idempotent: the same participant voting twice counts once', async () => {
    const s = await newSession();
    const body = { session_id: s.id, breadcrumb_id: id('middling'), value: 'useful' };
    const first = await call(votes, { method: 'POST', body });
    const second = await call(votes, { method: 'POST', body });
    expect(first.json.changed).toBe(true);
    expect(second.json.changed).toBe(false);
    expect(second.json.breadcrumb.useful_count).toBe(first.json.breadcrumb.useful_count);
    expect(second.json.breadcrumb.base_freshness).toBe(first.json.breadcrumb.base_freshness);
    const rows = await db.query('select 1 from votes where session_id = $1::uuid', [s.id]);
    expect(rows).toHaveLength(1);
  });

  it('lets a participant switch their vote without double counting', async () => {
    const s = await newSession();
    const target = id('middling');
    const start = (await list()).find((b) => b.id === target)!;
    await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: target, value: 'useful' } });
    const res = await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: target, value: 'not_useful' } });
    expect(res.json.breadcrumb.useful_count).toBe(start.useful_count);
    expect(res.json.breadcrumb.not_useful_count).toBe(start.not_useful_count + 1);
    expect(res.json.breadcrumb.my_vote).toBe('not_useful');
  });

  it('the database itself refuses a second vote row for the same participant', async () => {
    const s = await newSession();
    await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('popular'), value: 'useful' } });
    await expect(
      db.query("insert into votes (breadcrumb_id, session_id, value) values ($1::uuid, $2::uuid, 'useful')", [id('popular'), s.id]),
    ).rejects.toThrow();
  });

  it('two different participants both count', async () => {
    const a = await newSession();
    const b = await newSession();
    const start = (await list()).find((c) => c.id === id('popular'))!;
    await call(votes, { method: 'POST', body: { session_id: a.id, breadcrumb_id: start.id, value: 'useful' } });
    const res = await call(votes, { method: 'POST', body: { session_id: b.id, breadcrumb_id: start.id, value: 'useful' } });
    expect(res.json.breadcrumb.useful_count).toBe(start.useful_count + 2);
  });

  it('validates input and unknown sessions', async () => {
    const s = await newSession();
    expect((await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('popular'), value: 'love' } })).status).toBe(
      400,
    );
    expect(
      (await call(votes, { method: 'POST', body: { session_id: 'not-a-uuid', breadcrumb_id: id('popular'), value: 'useful' } })).status,
    ).toBe(400);
    const ghostSession = '11111111-1111-4111-8111-111111111111';
    expect(
      (await call(votes, { method: 'POST', body: { session_id: ghostSession, breadcrumb_id: id('popular'), value: 'useful' } })).status,
    ).toBe(404);
    expect((await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: ghostSession, value: 'useful' } })).status).toBe(
      404,
    );
    expect((await call(votes, { method: 'GET' })).status).toBe(405);
  });

  it('"Helped me" bumps the Helped counter once per participant', async () => {
    const s = await newSession();
    const start = (await list()).find((c) => c.id === id('middling'))!;
    const first = await call(helped, { method: 'POST', body: { session_id: s.id, breadcrumb_id: start.id } });
    const second = await call(helped, { method: 'POST', body: { session_id: s.id, breadcrumb_id: start.id } });
    expect(first.json.breadcrumb.helped_count).toBe(start.helped_count + 1);
    expect(first.json.breadcrumb.my_helped).toBe(true);
    expect(second.json.changed).toBe(false);
    expect(second.json.breadcrumb.helped_count).toBe(start.helped_count + 1);
  });

  it('a thank-you note can go with the thanks, or be added once afterwards, and never moves the count twice', async () => {
    const a = await newSession();
    const b = await newSession();
    const start = (await list()).find((c) => c.id === id('popular'))!;
    // with the first tap
    const withNote = await call(helped, {
      method: 'POST',
      body: { session_id: a.id, breadcrumb_id: start.id, note: '  Thanks,   this fixed it! ' },
    });
    expect(withNote.status).toBe(200);
    expect(withNote.json.breadcrumb.my_note).toBe('Thanks, this fixed it!');
    expect(withNote.json.breadcrumb.helped_count).toBe(start.helped_count + 1);
    // added after a plain thanks
    await call(helped, { method: 'POST', body: { session_id: b.id, breadcrumb_id: start.id } });
    const later = await call(helped, {
      method: 'POST',
      body: { session_id: b.id, breadcrumb_id: start.id, note: 'Made my first set easier.' },
    });
    expect(later.json.changed).toBe(true);
    expect(later.json.breadcrumb.my_note).toBe('Made my first set easier.');
    expect(later.json.breadcrumb.helped_count).toBe(start.helped_count + 2); // two people, not three
    // a second note does not replace the first
    const again = await call(helped, { method: 'POST', body: { session_id: b.id, breadcrumb_id: start.id, note: 'Changed my mind' } });
    expect(again.json.changed).toBe(false);
    expect(again.json.breadcrumb.my_note).toBe('Made my first set easier.');
    // a novice never sees other people's notes
    expect(again.json.breadcrumb.thanks_notes).toBeNull();
    const logged = await db.query("select 1 from behavior_events where event_type = 'thanks_note_sent'");
    expect(logged).toHaveLength(2);
  });

  it('a note is capped at 80 characters and stored as inert text', async () => {
    const s = await newSession();
    const post = (note: string) => call(helped, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('fresh-audio'), note } });
    expect((await post('x'.repeat(81))).status).toBe(400);
    const rows = await db.query('select 1 from helped_marks where session_id = $1::uuid', [s.id]);
    expect(rows).toHaveLength(0); // a rejected note does not count as a thanks
    const ok = await post('<b>thanks</b>');
    expect(ok.json.breadcrumb.my_note).toBe('<b>thanks</b>'); // rendered as text by React, never as HTML
    await expect(db.query('update helped_marks set note = $2 where session_id = $1::uuid', [s.id, 'y'.repeat(81)])).rejects.toThrow(); // the database enforces the cap too
  });

  it('authors see the thank-you notes on their own tips, and nobody else does', async () => {
    const author = await newSession();
    const other = await newSession();
    const thanker = await newSession();
    const posted = await call(breadcrumbs, {
      method: 'POST',
      body: { session_id: author.id, station: STATION.code, kind: 'text', body: 'Check the pin is all the way in.' },
    });
    const tip = posted.json.breadcrumb.id;
    expect(posted.json.breadcrumb.thanks_notes).toEqual([]); // the author gets a list, empty for now
    await call(helped, { method: 'POST', body: { session_id: thanker.id, breadcrumb_id: tip, note: 'Wish I knew this sooner.' } });
    const mine = (await list(author.id)).find((b) => b.id === tip)!;
    expect(mine.thanks_notes).toEqual(['Wish I knew this sooner.']);
    expect(mine.helped_count).toBe(1);
    for (const viewer of [other.id, thanker.id, undefined]) {
      expect((await list(viewer)).find((b) => b.id === tip)!.thanks_notes).toBeNull();
    }
    // Seeded tips belong to nobody in the room.
    expect((await list(author.id)).find((b) => b.id === id('popular'))!.thanks_notes).toBeNull();
    // The admin panel shows every note.
    const overview = (await call<AdminOverview>(adminActions, { token })).json;
    expect(overview.breadcrumbs.find((b) => b.id === tip)!.thanks_notes).toEqual(['Wish I knew this sooner.']);
  });

  it('nobody can thank their own tip', async () => {
    const author = await newSession();
    const posted = await call(breadcrumbs, {
      method: 'POST',
      body: { session_id: author.id, station: STATION.code, kind: 'text', body: 'Wipe the bench when you are done.' },
    });
    const res = await call(helped, { method: 'POST', body: { session_id: author.id, breadcrumb_id: posted.json.breadcrumb.id } });
    expect(res.status).toBe(403);
    expect((await list()).find((b) => b.id === posted.json.breadcrumb.id)!.helped_count).toBe(0);
  });

  it('rate-limits a participant hammering the vote route', async () => {
    const s = await newSession();
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const res = await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('popular'), value: 'useful' } });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('anyone adds a breadcrumb: text', () => {
  const post = (sessionId: string, body: Record<string, unknown>) =>
    call(breadcrumbs, { method: 'POST', body: { session_id: sessionId, station: STATION.code, ...body } });

  it('posts a text tip that shows up for everyone with Helped at zero', async () => {
    const author = await newSession();
    const reader = await newSession();
    const revBefore = (await call<StateResponse>(state, { url: '/api/state' })).json.settings.content_rev;
    const res = await post(author.id, {
      kind: 'text',
      body: '  Squeeze the bottles,   elbows under wrists. ',
      tags: ['for-beginners', 'bogus'],
    });
    expect(res.status).toBe(200);
    expect(res.json.merged).toBe(false);
    expect(res.json.breadcrumb.kind).toBe('text');
    expect(res.json.breadcrumb.body).toBe('Squeeze the bottles, elbows under wrists.');
    expect(res.json.breadcrumb.tags).toEqual(['for-beginners']);
    expect(res.json.breadcrumb.helped_count).toBe(0);
    expect(res.json.breadcrumb.audio_url).toBeNull();
    expect(res.json.breadcrumb.contributor.display_name).toBe(author.contributor.display_name);
    const seen = await list(reader.id);
    expect(seen.some((b) => b.id === res.json.breadcrumb.id)).toBe(true);
    // content_rev moves, which is what makes every phone refetch (the live update).
    const revAfter = (await call<StateResponse>(state, { url: '/api/state' })).json.settings.content_rev;
    expect(revAfter).toBeGreaterThan(revBefore);
  });

  it('merges a near-duplicate into the existing card with a count, per kind', async () => {
    const s = await newSession();
    const res = await post(s.id, { kind: 'text', body: 'stack your wrists right over your elbows the whole way up!!' });
    expect(res.json.merged).toBe(true);
    expect(res.json.breadcrumb.id).toBe(id('popular'));
    expect(res.json.breadcrumb.duplicate_count).toBe(2);
    expect(await list()).toHaveLength(6);
    // The same words as a read-aloud audio tip are a different breadcrumb: merging is per kind.
    const spoken = await post(s.id, { kind: 'audio', body: 'Stack your wrists right over your elbows the whole way up.' });
    expect(spoken.json.merged).toBe(false);
    expect(spoken.json.breadcrumb.kind).toBe('audio');
    expect(await list()).toHaveLength(7);
  });

  it('counts people, not posts: repeating a tip yourself does not inflate "N people left this tip"', async () => {
    const s = await newSession();
    // echoing someone else's tip twice still counts as one more person
    await post(s.id, { kind: 'text', body: 'Stack your wrists right over your elbows the whole way up.' });
    const again = await post(s.id, { kind: 'text', body: 'stack your wrists right over your elbows the whole way up' });
    expect(again.json.merged).toBe(true);
    expect(again.json.breadcrumb.duplicate_count).toBe(2);
    // reposting your own tip leaves it at one person
    const mine = await post(s.id, { kind: 'text', body: 'Grip the bottles like you mean it.' });
    const repeat = await post(s.id, { kind: 'text', body: 'grip the bottles like you mean it!' });
    expect(repeat.json.merged).toBe(true);
    expect(repeat.json.breadcrumb.id).toBe(mine.json.breadcrumb.id);
    expect(repeat.json.breadcrumb.duplicate_count).toBe(1);
  });

  it('requires a kind; rejects empty and too-long tips and removed fields; stores HTML as inert text', async () => {
    const s = await newSession();
    expect((await post(s.id, { body: 'A tip with no kind' })).status).toBe(400);
    expect((await post(s.id, { kind: 'hologram', body: 'hello there' })).status).toBe(400);
    expect((await post(s.id, { kind: 'text', body: ' ' })).status).toBe(400);
    expect((await post(s.id, { kind: 'text', body: 'x'.repeat(141) })).status).toBe(400);
    expect((await post(s.id, { kind: 'text' })).status).toBe(400);
    expect(
      (await post(s.id, { kind: 'text', body: 'Text cannot carry a clip', audio: { data: clip(WEBM), mime: 'audio/webm', seconds: 2 } }))
        .status,
    ).toBe(400);
    const html = await post(s.id, { kind: 'text', body: '<img src=x onerror=alert(1)> wrists' });
    expect(html.status).toBe(200);
    expect(html.json.breadcrumb.body).toBe('<img src=x onerror=alert(1)> wrists'); // rendered as text by React, never as HTML
  });

  it('a participant in the plain-text baseline cannot post', async () => {
    const s = await newSession(null, true);
    expect((await post(s.id, { kind: 'text', body: 'Should not land' })).status).toBe(403);
  });

  it('caps how many tips one session can leave', async () => {
    const s = await newSession();
    const words = [
      'seat',
      'grip',
      'elbows',
      'breathing',
      'tempo',
      'shoulders',
      'feet',
      'core',
      'wrists',
      'neck',
      'warmup',
      'rest',
      'water',
    ];
    let last = 200;
    for (const word of words) {
      resetRateLimits();
      last = (await post(s.id, { kind: 'text', body: `Pay attention to your ${word} on every rep.` })).status;
    }
    expect(last).toBe(429);
    expect((await list(undefined, '&kind=text')).length).toBe(4 + 12);
  });

  it('survives an injection attempt in a parameter', async () => {
    const s = await newSession();
    const res = await post(s.id, { kind: 'text', body: "'); drop table breadcrumbs; --" });
    expect(res.status).toBe(200);
    expect((await list()).length).toBe(7);
  });
});

describe('anyone adds a breadcrumb: audio', () => {
  const post = (sessionId: string, body: Record<string, unknown>) =>
    call(breadcrumbs, { method: 'POST', body: { session_id: sessionId, station: STATION.code, kind: 'audio', ...body } });

  it('stores a recording and serves it back, whole and in byte ranges', async () => {
    const s = await newSession();
    const data = clip(WEBM, 3000);
    const res = await post(s.id, { audio: { data, mime: 'audio/webm;codecs=opus', seconds: 4.26 }, tags: ['for-beginners'] });
    expect(res.status).toBe(200);
    const crumb = res.json.breadcrumb as Breadcrumb;
    expect(crumb.kind).toBe('audio');
    expect(crumb.body).toBe(''); // a recording has no transcript
    expect(crumb.audio_seconds).toBe(4.3);
    expect(crumb.audio_url).toBe(`/api/audio?id=${crumb.id}`);
    expect(crumb.contributor.display_name).toBe(s.contributor.display_name);
    // everyone's Audio list now has it (the panel floats just-posted tips to the top: see the tabList test)
    expect((await list(undefined, '&kind=audio')).map((b) => b.id)).toContain(crumb.id);

    const whole = await call(audio, { url: crumb.audio_url! });
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('audio/webm'); // the codecs suffix is stripped
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.bytes.equals(Buffer.from(data, 'base64'))).toBe(true);

    // iPhone Safari asks for audio in ranges and will not play without them.
    const part = await call(audio, { url: crumb.audio_url!, headers: { range: 'bytes=0-1' } });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 0-1/3004');
    expect([...part.bytes]).toEqual([0x1a, 0x45]);
    const tail = await call(audio, { url: crumb.audio_url!, headers: { range: 'bytes=3000-' } });
    expect(tail.status).toBe(206);
    expect(tail.bytes.length).toBe(4);
    expect((await call(audio, { url: crumb.audio_url!, headers: { range: 'bytes=9000-' } })).status).toBe(416);
    expect((await call(audio, { url: '/api/audio?id=11111111-1111-4111-8111-111111111111' })).status).toBe(404);
    expect((await call(audio, { url: '/api/audio?id=nope' })).status).toBe(400);
  });

  it('accepts what iPhone Safari records (mp4) as well as what Chrome records (webm)', async () => {
    const s = await newSession();
    const mp4 = await post(s.id, { audio: { data: clip(MP4), mime: 'audio/mp4', seconds: 3 } });
    expect(mp4.status).toBe(200);
    const m4a = await post(s.id, { audio: { data: clip(MP4), mime: 'audio/x-m4a', seconds: 3 } });
    expect(m4a.status).toBe(200);
    const stored = await db.query<{ mime: string }>('select mime from audio_clips order by created_at');
    expect(stored.map((r) => r.mime)).toEqual(['audio/mp4', 'audio/mp4']);
  });

  it('validates the type, the real file header, the size and the length', async () => {
    const s = await newSession();
    const audioOf = (data: string, mime: string, seconds = 3) => post(s.id, { audio: { data, mime, seconds } });
    expect((await audioOf(clip(WEBM), 'video/webm')).status).toBe(415); // not an audio type
    expect((await audioOf(clip(WEBM), 'application/octet-stream')).status).toBe(415);
    expect((await audioOf(clip([0x4d, 0x5a, 0x90, 0x00]), 'audio/webm')).status).toBe(415); // labelled audio, is not
    expect((await audioOf(clip(WEBM), 'audio/mp4')).status).toBe(415); // header does not match the label
    expect((await audioOf('not base64 !!', 'audio/webm')).status).toBe(400);
    expect((await audioOf(clip(WEBM), 'audio/webm', 25)).status).toBe(400); // longer than 20 seconds
    expect((await audioOf(clip(WEBM), 'audio/webm', 0)).status).toBe(400);
    // 1 MB is the cap: one byte under is fine, anything over is refused before it is stored.
    resetRateLimits();
    expect((await audioOf(clip(WEBM, 1024 * 1024 - 4), 'audio/webm')).status).toBe(200);
    expect((await audioOf(clip(WEBM, 1024 * 1024 - 3), 'audio/webm')).status).toBe(413);
    expect(await db.query('select 1 from audio_clips')).toHaveLength(1);
    // The database enforces the same cap and type list.
    await expect(
      db.query(`insert into audio_clips (mime, bytes) values ('audio/webm', decode($1, 'base64'))`, [clip(WEBM, 1024 * 1024)]),
    ).rejects.toThrow();
    await expect(
      db.query(`insert into audio_clips (mime, bytes) values ('video/mp4', decode($1, 'base64'))`, [clip(MP4)]),
    ).rejects.toThrow();
  });

  it('rate-limits recordings and caps them per session', async () => {
    const s = await newSession();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(s.id, { audio: { data: clip(WEBM), mime: 'audio/webm', seconds: 2 } })).status);
    expect(statuses).toEqual([200, 200, 200, 429]); // three a minute
    resetRateLimits();
    for (let i = 0; i < 2; i++) await post(s.id, { audio: { data: clip(WEBM), mime: 'audio/webm', seconds: 2 } });
    resetRateLimits();
    const sixth = await post(s.id, { audio: { data: clip(WEBM), mime: 'audio/webm', seconds: 2 } });
    expect(sixth.status).toBe(429); // five recordings per session
    expect(sixth.json.error.code).toBe('clip_limit');
  });

  it('"Type it and I will read it aloud": an audio tip with words and no clip', async () => {
    const s = await newSession();
    const res = await post(s.id, { body: 'Exhale on the way up and keep your ribs down.' });
    expect(res.status).toBe(200);
    expect(res.json.breadcrumb.kind).toBe('audio');
    expect(res.json.breadcrumb.audio_url).toBeNull(); // phones speak the body with their own voice
    expect(res.json.breadcrumb.audio_seconds).toBeNull();
    expect(res.json.breadcrumb.body).toBe('Exhale on the way up and keep your ribs down.');
    expect((await post(s.id, { body: '' })).status).toBe(400); // needs words or a clip
    expect((await post(s.id, { body: 'x'.repeat(141) })).status).toBe(400);
    const logged = await db.query<{ metadata: { shape: string; kind: string } }>(
      "select metadata from behavior_events where session_id = $1::uuid and event_type = 'breadcrumb_added'",
      [s.id],
    );
    expect(logged[0].metadata).toMatchObject({ kind: 'audio', shape: 'read_aloud' });
  });

  it('votes, thanks and decay work on audio tips exactly as on text tips', async () => {
    const s = await newSession();
    const before = (await list()).find((b) => b.id === id('ignored-audio'))!;
    const voted = await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: before.id, value: 'useful' } });
    expect(voted.json.breadcrumb.useful_count).toBe(1);
    const thanked = await call(helped, {
      method: 'POST',
      body: { session_id: s.id, breadcrumb_id: before.id, note: 'Thanks, this fixed it!' },
    });
    expect(thanked.json.breadcrumb.helped_count).toBe(1);
    expect(thanked.json.breadcrumb.rank_score).toBeGreaterThan(before.rank_score);
  });
});

describe('session state, time-skip and decay', () => {
  it('state endpoint returns settings, the server clock and whether the session exists', async () => {
    const s = await newSession();
    const res = await call<StateResponse>(state, { url: `/api/state?session_id=${s.id}` });
    expect(res.json.settings.auto_skip_enabled).toBe(true);
    expect(res.json.settings).not.toHaveProperty('feedback_mode');
    expect(res.json.session_found).toBe(true);
    expect(Math.abs(Date.parse(res.json.server_now) - Date.now())).toBeLessThan(5000);
    const gone = await call<StateResponse>(state, { url: '/api/state?session_id=11111111-1111-4111-8111-111111111111' });
    expect(gone.json.session_found).toBe(false);
  });

  it('admin Fast-forward shifts one number and rewrites no breadcrumb rows', async () => {
    const before = await db.query('select id, base_freshness, last_interaction_at, rank_score from breadcrumbs order by id');
    const overview = await admin({ type: 'time_skip', seconds: 7 * DAY_SECONDS });
    expect(overview.settings.virtual_clock_offset_seconds).toBe(7 * DAY_SECONDS);
    const after = await db.query('select id, base_freshness, last_interaction_at, rank_score from breadcrumbs order by id');
    expect(after).toEqual(before);

    // The same rows, read through the real decay rule, now show the rehearsed outcome.
    const crumbs = await list();
    const clock = {
      nowMs: virtualNowMs(Date.now(), overview.settings.virtual_clock_offset_seconds),
      busyness: overview.settings.gym_busyness,
      multiplier: 1,
      skipActive: true,
    };
    const stateOf = (nickname: string) =>
      freshnessState(
        freshnessAt(
          crumbs.find((b) => b.id === id(nickname))!,
          clock,
        ),
      );
    expect(stateOf('popular')).toBe('fresh');
    expect(stateOf('middling')).toBe('fading');
    expect(stateOf('ignored-audio')).toBe('stale');
    expect(stateOf('ignored-old')).toBe('gone');
    // Faded breadcrumbs are hidden by the client, never deleted.
    expect(crumbs).toHaveLength(6);
  });

  it('skips accumulate, are validated, and Reset time and restore undoes everything', async () => {
    await admin({ type: 'time_skip', seconds: DAY_SECONDS });
    const two = await admin({ type: 'time_skip', seconds: 30 * DAY_SECONDS });
    expect(two.settings.virtual_clock_offset_seconds).toBe(31 * DAY_SECONDS);
    expect((await call(adminActions, { method: 'POST', token, body: { type: 'time_skip', seconds: 12345 } })).status).toBe(400);

    const s = await newSession();
    await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('ignored-old'), value: 'useful' } });
    await admin({ type: 'set_pin', breadcrumb_id: id('popular'), pin_state: 'force_stale' });
    const restored = await admin({ type: 'reset_time' });
    expect(restored.settings.virtual_clock_offset_seconds).toBe(0);
    const crumb = restored.breadcrumbs.find((b) => b.id === id('ignored-old'))!;
    expect(crumb.useful_count).toBe(0);
    expect(restored.breadcrumbs.every((b) => b.pin_state === 'none')).toBe(true);
    expect(await db.query('select 1 from votes')).toHaveLength(0);
  });

  it('a vote cast after a skip is timestamped on the virtual clock', async () => {
    await admin({ type: 'time_skip', seconds: 7 * DAY_SECONDS });
    const s = await newSession();
    const res = await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('ignored-audio'), value: 'useful' } });
    const b: Breadcrumb = res.json.breadcrumb;
    expect(Date.parse(b.last_interaction_at) - Date.now()).toBeGreaterThan(6.9 * DAY_SECONDS * 1000);
    // ~22.6 (stale after a week) + 12 for the vote
    expect(b.base_freshness).toBeGreaterThan(30);
    expect(b.base_freshness).toBeLessThan(40);
  });

  it('pins are stored as a state, never as rewritten freshness', async () => {
    const before = await db.query('select base_freshness from breadcrumbs where id = $1::uuid', [id('ignored-old')]);
    const overview = await admin({ type: 'set_pin', breadcrumb_id: id('ignored-old'), pin_state: 'keep_fresh' });
    const crumb = overview.breadcrumbs.find((b) => b.id === id('ignored-old'))!;
    expect(crumb.pin_state).toBe('keep_fresh');
    const after = await db.query('select base_freshness from breadcrumbs where id = $1::uuid', [id('ignored-old')]);
    expect(after).toEqual(before);
    expect(freshnessAt(crumb, { nowMs: Date.now() + 30 * DAY_SECONDS * 1000, busyness: 'normal', multiplier: 1, skipActive: true })).toBe(
      100,
    );
  });

  it('the scripted skip belongs to one phone only, and can be switched off', async () => {
    const a = await newSession();
    const b = await newSession();
    const res = await call(state, { method: 'POST', body: { session_id: a.id, action: 'scripted_skip' } });
    expect(res.json.clock_skip_seconds).toBe(SCRIPTED_SKIP_SECONDS);
    expect((await call<StateResponse>(state, { url: `/api/state?session_id=${a.id}` })).json.clock_skip_seconds).toBe(
      SCRIPTED_SKIP_SECONDS,
    );
    expect((await call<StateResponse>(state, { url: `/api/state?session_id=${b.id}` })).json.clock_skip_seconds).toBe(0);
    expect((await call<StateResponse>(state, { url: '/api/state' })).json.settings.virtual_clock_offset_seconds).toBe(0);

    await admin({ type: 'set_auto_skip', value: false });
    expect((await call(state, { method: 'POST', body: { session_id: b.id, action: 'scripted_skip' } })).status).toBe(409);
  });
});

describe('admin panel', () => {
  it('rejects a wrong PIN and issues a signed, expiring token for the right one', async () => {
    expect((await call(adminLogin, { method: 'POST', body: { pin: '0000' } })).status).toBe(401);
    expect(verifyToken(token)).toBe(true);
    expect(verifyToken(token, Date.now() + 3 * 60 * 60 * 1000)).toBe(false);
    expect(verifyToken(`${token.split('.')[0]}.forged`)).toBe(false);
    expect(verifyToken('garbage')).toBe(false);
  });

  it('locks out PIN guessing', async () => {
    let status = 0;
    for (let i = 0; i < 12; i++) status = (await call(adminLogin, { method: 'POST', body: { pin: `${i}` }, ip: '10.9.9.9' })).status;
    expect(status).toBe(429);
  });

  it('protects every admin route', async () => {
    expect((await call(adminActions, {})).status).toBe(401);
    expect((await call(adminActions, { method: 'POST', body: { type: 'reset_time' } })).status).toBe(401);
    expect((await call(adminResults, {})).status).toBe(401);
    expect((await call(adminResults, { url: '/api/admin/results?token=nope' })).status).toBe(401);
  });

  it('the removed hologram, form-color, tracking and feedback-mode controls are gone from the API', async () => {
    const post = (body: Record<string, unknown>) => call(adminActions, { method: 'POST', token, body });
    for (const body of [
      { type: 'set_mode', mode: 'manual' },
      { type: 'force_joint', joint: 'wrist', color: 'red' },
      { type: 'ghost', op: 'pause' },
      { type: 'set_feedback_mode', mode: 'tracked' },
      { type: 'set_lock_scripted', locked: false },
      { type: 'feature_breadcrumb', breadcrumb_id: id('popular') },
      { type: 'self_destruct' },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    const settings = (await call<AdminOverview>(adminActions, { token })).json.settings;
    expect(Object.keys(settings).sort()).toEqual(
      [
        'auto_skip_enabled',
        'content_rev',
        'decay_multiplier',
        'gym_busyness',
        'prototype_version',
        'session_epoch',
        'survey_nonce',
        'survey_session_id',
        'virtual_clock_offset_seconds',
      ].sort(),
    );
  });

  it("toggles the Loaf badge and refreshes the rank of that author's tips", async () => {
    const target = id('middling');
    const start = (await list()).find((b) => b.id === target)!;
    let o = await admin({ type: 'set_loaf', contributor_id: start.contributor_id, value: true });
    let crumb = o.breadcrumbs.find((b) => b.id === target)!;
    expect(crumb.contributor.has_loaf_badge).toBe(true);
    expect(crumb.rank_score - start.rank_score).toBeCloseTo(DECAY.rank.loaf, 1);
    o = await admin({ type: 'set_loaf', contributor_id: start.contributor_id, value: false });
    crumb = o.breadcrumbs.find((b) => b.id === target)!;
    expect(crumb.contributor.has_loaf_badge).toBe(false);
    expect(crumb.rank_score).toBeCloseTo(start.rank_score, 1);
  });

  it('keep-fresh and make-stale pins change what a phone sees without touching the stored freshness', async () => {
    const now = { nowMs: Date.now(), busyness: 'normal' as const, multiplier: 1, skipActive: false };
    const afterSkip = { ...now, nowMs: Date.now() + DAY_SECONDS * 1000, skipActive: true };
    const stateOf = (o: AdminOverview, nickname: string, clock: typeof now) =>
      freshnessState(
        freshnessAt(
          o.breadcrumbs.find((b) => b.id === id(nickname))!,
          clock,
        ),
      );
    // Make stale: nothing is yanked away mid-read; the tip fades out at the next time-skip.
    let o = await admin({ type: 'set_pin', breadcrumb_id: id('popular'), pin_state: 'force_stale' });
    expect(stateOf(o, 'popular', now)).toBe('fresh');
    expect(stateOf(o, 'popular', afterSkip)).toBe('gone');
    // Keep fresh: an already-stale tip shows as fresh at once, and stays fresh through a skip.
    o = await admin({ type: 'set_pin', breadcrumb_id: id('ignored-old'), pin_state: 'keep_fresh' });
    expect(stateOf(o, 'ignored-old', now)).toBe('fresh');
    expect(stateOf(o, 'ignored-old', { ...afterSkip, nowMs: Date.now() + 30 * DAY_SECONDS * 1000 })).toBe('fresh');
    const stored = await db.query<{ base_freshness: number }>('select base_freshness from breadcrumbs where id = $1::uuid', [
      id('popular'),
    ]);
    expect(Number(stored[0].base_freshness)).toBe(100);
    o = await admin({ type: 'set_pin', breadcrumb_id: id('popular'), pin_state: 'none' });
    expect(stateOf(o, 'popular', afterSkip)).toBe('fresh');
  });

  it('logs every action with a timestamp and flags sessions that were steered by hand', async () => {
    const steered = await newSession();
    const o = await admin({ type: 'set_pin', breadcrumb_id: id('middling'), pin_state: 'keep_fresh' });
    expect(o.actions[0].action_type).toBe('set_pin');
    expect(o.actions[0].payload).toEqual({ breadcrumb_id: id('middling'), pin_state: 'keep_fresh' });
    expect(Date.parse(o.actions[0].created_at)).toBeGreaterThan(Date.now() - 5000);
    expect(o.sessions.find((s) => s.id === steered.id)!.override_active).toBe(true);

    // A session that starts while an override is still live is flagged too.
    const during = await newSession();
    const afterClear = await admin({ type: 'set_pin', breadcrumb_id: id('middling'), pin_state: 'none' });
    expect(afterClear.sessions.find((s) => s.id === during.id)!.override_active).toBe(true);
    const clean = await newSession();
    const final = await call<AdminOverview>(adminActions, { token });
    expect(final.json.sessions.find((s) => s.id === clean.id)!.override_active).toBe(false);
    // A fast-forward is steering as well.
    await admin({ type: 'time_skip', seconds: DAY_SECONDS });
    expect((await call<AdminOverview>(adminActions, { token })).json.sessions.find((s) => s.id === clean.id)!.override_active).toBe(true);
    expect((await newSession()).id).toBeTruthy();
  });

  it('session reset bumps the epoch; Start survey targets a session', async () => {
    const s = await newSession();
    const before = (await call<AdminOverview>(adminActions, { token })).json.settings;
    let o = await admin({ type: 'start_survey', session_id: s.id });
    expect(o.settings.survey_nonce).toBe(before.survey_nonce + 1);
    expect(o.settings.survey_session_id).toBe(s.id);
    o = await admin({ type: 'new_participant' });
    expect(o.settings.session_epoch).toBe(before.session_epoch + 1);
    expect(o.settings.survey_session_id).toBeNull();
  });
});

describe('survey, behavior log, results and CSV', () => {
  it('saves answers tagged with session and version; resubmitting replaces', async () => {
    const s = await newSession();
    const first = await call(survey, {
      method: 'POST',
      body: {
        session_id: s.id,
        answers: [
          { key: 'gym_comfort', answer: 2 },
          { key: 'trust_why', answer: '  the checkmark, mostly ' },
          { key: 'most_confusing', answer: '' },
        ],
      },
    });
    expect(first.json.saved).toBe(2);
    await call(survey, { method: 'POST', body: { session_id: s.id, answers: [{ key: 'gym_comfort', answer: 4 }], final: true } });
    const rows = await db.query<{ question_key: string; answer: string }>(
      'select question_key, answer from survey_responses where session_id = $1::uuid order by question_key',
      [s.id],
    );
    expect(rows).toEqual([
      { question_key: 'gym_comfort', answer: '4' },
      { question_key: 'trust_why', answer: 'the checkmark, mostly' },
    ]);
    const overview = (await call<AdminOverview>(adminActions, { token })).json;
    const row = overview.sessions.find((x) => x.id === s.id)!;
    expect(row.completed_at).not.toBeNull();
    expect(row.answers).toBe(2);
    expect(row.guest_name).toBe(s.contributor.display_name);
    expect(row).not.toHaveProperty('role');
  });

  it('accepts the new questions; rejects unknown questions, out-of-range answers and the removed ones', async () => {
    const s = await newSession();
    const post = (answers: unknown) => call(survey, { method: 'POST', body: { session_id: s.id, answers } });
    expect((await post([{ key: 'gym_experience', answer: 'brand_new' }])).status).toBe(200);
    expect((await post([{ key: 'first_tab', answer: 'audio' }])).status).toBe(200);
    expect((await post([{ key: 'audio_vs_reading_why', answer: 'I could keep my eyes on the weights' }])).status).toBe(200);
    expect((await post([{ key: 'favorite_color', answer: 'blue' }])).status).toBe(400);
    expect((await post([{ key: 'gym_comfort', answer: 9 }])).status).toBe(400);
    expect((await post([{ key: 'gym_experience', answer: 'olympian' }])).status).toBe(400);
    expect((await post([{ key: 'first_tab', answer: 'hologram' }])).status).toBe(400);
    for (const removed of ['ghost_helped', 'first_hotspot', 'camera_flip', 'form_colors_clear']) {
      expect((await post([{ key: removed, answer: 4 }])).status, removed).toBe(400);
    }
  });

  it('accepts client behavior events but not ones that assert server facts', async () => {
    const s = await newSession('novice');
    const ok = await call(events, {
      method: 'POST',
      body: {
        session_id: s.id,
        events: [
          { event_type: 'tab_opened', metadata: { tab: 'audio', first: true }, at: Date.now() },
          { event_type: 'tip_viewed', breadcrumb_id: id('fresh-audio'), metadata: { kind: 'audio', loaf: true } },
          { event_type: 'audio_started', breadcrumb_id: id('fresh-audio'), metadata: { mode: 'file' } },
          { event_type: 'audio_stopped', breadcrumb_id: id('fresh-audio'), metadata: { listened_ms: 12400, completed: false } },
          { event_type: 'tab_closed', metadata: { tab: 'audio', duration_ms: 15200 } },
          { event_type: 'breadcrumb_faded', breadcrumb_id: id('ignored-old'), metadata: { label: 'Seat pin', state: 'gone' } },
        ],
      },
    });
    expect(ok.json.saved).toBe(6);
    for (const forgedType of [
      'vote_cast',
      'helped_marked',
      'thanks_note_sent',
      'breadcrumb_added',
      'ghost_played',
      'follow_started',
      'hotspot_opened',
    ]) {
      const forged = await call(events, { method: 'POST', body: { session_id: s.id, events: [{ event_type: forgedType }] } });
      expect(forged.status, forgedType).toBe(400);
    }
    const stored = await db.query<{ metadata: Record<string, unknown> }>(
      "select metadata from behavior_events where session_id = $1::uuid and event_type = 'tab_opened'",
      [s.id],
    );
    expect(stored[0].metadata.group).toBe('novice'); // stamped by the server from the session row
    expect(stored[0].metadata).not.toHaveProperty('role');
  });

  it('results view and CSV combine survey answers with logged behavior', async () => {
    const s = await newSession('expert');
    await call(events, {
      method: 'POST',
      body: {
        session_id: s.id,
        events: [
          { event_type: 'tab_opened', metadata: { tab: 'audio', first: true } },
          { event_type: 'tip_viewed', breadcrumb_id: id('fresh-audio'), metadata: { kind: 'audio', loaf: true } },
          { event_type: 'audio_started', breadcrumb_id: id('fresh-audio'), metadata: { mode: 'file' } },
          { event_type: 'audio_stopped', breadcrumb_id: id('fresh-audio'), metadata: { listened_ms: 12400, completed: false } },
          { event_type: 'audio_started', breadcrumb_id: id('ignored-audio'), metadata: { mode: 'file' } },
          { event_type: 'audio_stopped', breadcrumb_id: id('ignored-audio'), metadata: { listened_ms: 14600, completed: true } },
          { event_type: 'transcript_opened', breadcrumb_id: id('fresh-audio'), metadata: {} },
          { event_type: 'tab_closed', metadata: { tab: 'audio', duration_ms: 31000 } },
          { event_type: 'tab_opened', metadata: { tab: 'text', first: false } },
          { event_type: 'tip_viewed', breadcrumb_id: id('popular-flagged'), metadata: { kind: 'text', flagged: true } },
          { event_type: 'see_more_opened', metadata: { tab: 'text' } },
          { event_type: 'tab_closed', metadata: { tab: 'text', duration_ms: 9400 } },
        ],
      },
    });
    await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('fresh-audio'), value: 'useful' } });
    await call(helped, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('fresh-audio'), note: 'Thanks, this fixed it!' } });
    await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('popular-flagged'), value: 'not_useful' } });
    await call(breadcrumbs, {
      method: 'POST',
      body: { session_id: s.id, station: STATION.code, kind: 'text', body: 'Do one slow practice rep first.' },
    });
    await call(breadcrumbs, {
      method: 'POST',
      body: { session_id: s.id, station: STATION.code, kind: 'audio', audio: { data: clip(WEBM), mime: 'audio/webm', seconds: 5 } },
    });
    await call(survey, {
      method: 'POST',
      body: {
        session_id: s.id,
        final: true,
        answers: [
          { key: 'trust', answer: 5 },
          { key: 'gym_experience', answer: 'experienced' },
          { key: 'first_tab', answer: 'text' },
          { key: 'faded_meaning', answer: 'old, "stale" advice, nobody uses it' },
          { key: 'posted_why', answer: '=HYPERLINK("http://x")' },
        ],
      },
    });

    const json = await call<ResultsResponse>(adminResults, { token });
    const mine = json.json.sessions.find((x) => x.id === s.id)!;
    expect(mine.group).toBe('expert');
    expect(mine).not.toHaveProperty('role');
    expect(mine.prototype_version).toBe('session_1');
    expect(mine.answers.trust).toBe('5');
    // What they did (opened Audio first) next to what they said (Text).
    expect(mine.behavior.first_tab).toBe('audio');
    expect(mine.answers.first_tab).toBe('text');
    expect(mine.behavior.tabs_opened).toEqual(['audio', 'text']);
    expect(mine.behavior.tab_view_ms).toEqual({ audio: 31000, text: 9400 });
    expect(mine.behavior.tips_viewed).toBe(2);
    expect(mine.behavior.audio_plays).toBe(2);
    expect(mine.behavior.audio_listened_seconds).toBe(27);
    expect(mine.behavior.audio_completed).toBe(1);
    expect(mine.behavior.transcripts_opened).toBe(1);
    expect(mine.behavior.votes_cast).toBe(2);
    expect(mine.behavior.thanks_sent).toBe(1);
    expect(mine.behavior.thanks_notes_sent).toBe(1);
    expect(mine.behavior.see_more_used).toBe(true);
    expect(mine.behavior.tips_added).toBe(2);
    expect(mine.behavior.added_kinds.slice().sort()).toEqual(['audio', 'text']);
    expect(mine.behavior.reacted_to_loaf).toBe(true);
    expect(mine.behavior.reacted_to_flagged).toBe(true);
    expect(mine.override_active).toBe(false);

    const csv = await call(adminResults, { url: `/api/admin/results?format=csv&token=${token}` });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    const lines = csv.text.replace(String.fromCharCode(0xfeff), '').trim().split('\r\n');
    const header = lines[0].split(',');
    expect(header).toEqual(
      expect.arrayContaining([
        'session_id',
        'group',
        'prototype_version',
        'admin_override_active',
        'first_tab_opened',
        'text_tab_seconds',
        'audio_tab_seconds',
        'tips_viewed',
        'audio_plays',
        'audio_seconds_listened',
        'audio_clips_finished',
        'votes_cast',
        'thanks_sent',
        'thanks_notes_sent',
        'tips_added',
        'added_kinds',
        'faded_breadcrumbs',
        'gym_experience',
        'first_tab',
        'glasses_natural',
        'trust',
        'posted_why',
        'audio_why_not',
      ]),
    );
    for (const gone of [
      'role',
      'feedback_mode',
      'ghost_played',
      'follow_camera',
      'first_layer_opened',
      'first_hotspot_opened',
      'tracking_fps',
    ])
      expect(header).not.toContain(gone);
    const line = lines.find((l) => l.startsWith(s.id))!;
    const cell = (name: string) => line.split(',')[header.indexOf(name)];
    expect(cell('group')).toBe('expert');
    expect(cell('first_tab_opened')).toBe('audio');
    expect(cell('audio_tab_seconds')).toBe('31');
    expect(cell('audio_plays')).toBe('2');
    expect(cell('audio_seconds_listened')).toBe('27');
    expect(line).toContain('"old, ""stale"" advice, nobody uses it"');
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`); // formula defused

    const eventsCsv = await call(adminResults, { url: '/api/admin/results?format=csv&kind=events', token });
    expect(eventsCsv.text).toContain('vote_cast');
    expect(eventsCsv.text).toContain('thanks_note_sent');
    expect(eventsCsv.text).toContain('audio_stopped');
    expect(eventsCsv.text.split('\r\n')[0]).toContain('group');
    const long = await call(adminResults, { url: '/api/admin/results?format=csv&kind=responses', token });
    expect(long.text).toContain('faded_meaning');
  });

  it('a session started while an admin override was active is flagged in the results', async () => {
    await admin({ type: 'time_skip', seconds: DAY_SECONDS });
    const steered = await newSession();
    const json = await call<ResultsResponse>(adminResults, { token });
    expect(json.json.sessions.find((x) => x.id === steered.id)!.override_active).toBe(true);
    await admin({ type: 'reset_time' });
  });

  it('escapes CSV cells', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('+1 for this')).toBe("'+1 for this");
    expect(csvCell(['text', 'audio'])).toBe('text; audio');
    expect(csvCell(null)).toBe('');
  });

  it('plain-text baseline sessions are tagged and cannot vote', async () => {
    const s = await newSession(null, true);
    expect(s.baseline_mode).toBe(true);
    const res = await call(votes, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('popular'), value: 'useful' } });
    expect(res.status).toBe(403);
    expect((await call(helped, { method: 'POST', body: { session_id: s.id, breadcrumb_id: id('popular') } })).status).toBe(403);
  });
});

describe('databases from an earlier build', () => {
  it('refuses to run on the old role/hotspot schema instead of half-upgrading it, and says how to reset', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { OldSchemaError, dropAppTables, runMigrations } = await import('../db/migrations');
    const pg = new PGlite();
    await pg.exec(`
      create table schema_migrations (name text primary key, applied_at timestamptz not null default now());
      insert into schema_migrations (name) values ('001_init.sql'), ('002_breadcrumbs_only.sql');
      create table sessions (id uuid primary key default gen_random_uuid(), role text not null);
      create table breadcrumbs (id uuid primary key default gen_random_uuid(), hotspot text not null, body text not null);
      insert into sessions (role) values ('novice');
    `);
    const old: Db = {
      query: async (text, params) => (await pg.query(text, params as unknown[])).rows as never,
      exec: async (text) => void (await pg.exec(text)),
      tx: async (fn) => fn(old),
    };
    await expect(runMigrations(old)).rejects.toBeInstanceOf(OldSchemaError);
    await expect(runMigrations(old)).rejects.toThrow(/db:reset/);
    // Nothing was touched by the refusal.
    expect((await pg.query('select role from sessions')).rows).toEqual([{ role: 'novice' }]);
    // The reset path: drop the app's tables, then the normal migration builds the new schema.
    await dropAppTables(old);
    await runMigrations(old);
    const columns = (
      await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'breadcrumbs'")
    ).rows.map((r) => r.column_name);
    expect(columns).toContain('kind');
    expect(columns).not.toContain('hotspot');
    await pg.close();
  });
});
