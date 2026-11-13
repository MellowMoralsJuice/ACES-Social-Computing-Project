/**
 * Applies the seed content. Used by `npm run db:seed`, by local dev on first
 * start, and by the admin "Reset time and restore" button.
 *
 *  - Normal run: inserts anything missing and leaves existing rows alone,
 *    so it is safe to run more than once.
 *  - restore = true: also puts every seeded breadcrumb back to its starting
 *    values (counts, freshness, flags, pins) and clears votes on them.
 */
import { freshnessAt, rankScore } from '../../shared/decay.js';
import { SEED_BREADCRUMBS, SEED_CONTRIBUTORS, STATION, seedTextHash } from '../../shared/seed.js';
import type { Db } from './db.js';

const HOUR_MS = 3_600_000;

export async function applySeed(db: Db, options: { restore?: boolean } = {}, nowMs = Date.now()): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `insert into stations (id, name, code) values ($1::uuid, $2, $3)
       on conflict (id) do update set name = excluded.name, code = excluded.code`,
      [STATION.id, STATION.name, STATION.code],
    );
    await tx.query('insert into settings (id) values (true) on conflict (id) do nothing');

    for (const c of SEED_CONTRIBUTORS) {
      await tx.query(
        `insert into contributors (id, display_name, has_loaf_badge, is_seeded)
         values ($1::uuid, $2, $3, true)
         on conflict (id) do update set display_name = excluded.display_name
           ${options.restore ? ', has_loaf_badge = excluded.has_loaf_badge' : ''}`,
        [c.id, c.display_name, c.has_loaf_badge],
      );
    }

    for (const b of SEED_BREADCRUMBS) {
      const lastInteraction = new Date(nowMs - b.lastInteractionHoursAgo * HOUR_MS).toISOString();
      const contributor = SEED_CONTRIBUTORS.find((c) => c.id === b.contributor_id);
      const freshness = freshnessAt(
        { ...b, last_interaction_at: lastInteraction, pin_state: 'none' },
        { nowMs, busyness: 'normal', multiplier: 1, skipActive: false },
      );
      const rank = rankScore({ ...b, has_loaf_badge: contributor?.has_loaf_badge ?? false }, freshness);
      const onConflict = options.restore
        ? `do update set kind = excluded.kind, body = excluded.body, audio_url = excluded.audio_url,
             audio_seconds = excluded.audio_seconds, base_freshness = excluded.base_freshness,
             last_interaction_at = excluded.last_interaction_at, created_at = excluded.created_at,
             is_verified = excluded.is_verified, is_flagged = excluded.is_flagged,
             helped_count = excluded.helped_count, useful_count = excluded.useful_count,
             not_useful_count = excluded.not_useful_count, rank_score = excluded.rank_score,
             tags = excluded.tags, text_hash = excluded.text_hash, pin_state = 'none', duplicate_count = 1`
        : // What a seeded tip is and says always follows the seed; its votes and freshness are left alone.
          `do update set kind = excluded.kind, body = excluded.body, audio_url = excluded.audio_url,
             audio_seconds = excluded.audio_seconds, tags = excluded.tags, text_hash = excluded.text_hash`;
      await tx.query(
        `insert into breadcrumbs (id, station_id, kind, body, contributor_id, base_freshness,
             last_interaction_at, created_at, is_verified, is_flagged, helped_count, useful_count,
             not_useful_count, rank_score, tags, text_hash, is_seeded, audio_url, audio_seconds)
         values ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, ($7::text)::timestamptz,
             ($8::text)::timestamptz, $9, $10, $11, $12, $13, $14,
             array(select jsonb_array_elements_text(($15::text)::jsonb)), $16, true, $17, $18)
         on conflict (id) ${onConflict}`,
        [
          b.id,
          STATION.id,
          b.kind,
          b.body,
          b.contributor_id,
          b.base_freshness,
          lastInteraction,
          new Date(nowMs - b.createdHoursAgo * HOUR_MS).toISOString(),
          b.is_verified,
          b.is_flagged,
          b.helped_count,
          b.useful_count,
          b.not_useful_count,
          rank,
          JSON.stringify(b.tags),
          seedTextHash(b),
          b.audio_url,
          b.audio_seconds,
        ],
      );
    }

    // Seeded tips from an earlier version of the seed that are no longer in it.
    await tx.query(
      `delete from breadcrumbs where is_seeded and not (id = any(array(select jsonb_array_elements_text(($1::text)::jsonb))::uuid[]))`,
      [JSON.stringify(SEED_BREADCRUMBS.map((b) => b.id))],
    );

    if (options.restore) {
      // Let participants vote again on the restored tips. The behavior log keeps the history.
      await tx.query('delete from votes where breadcrumb_id in (select id from breadcrumbs where is_seeded)');
      await tx.query('delete from helped_marks where breadcrumb_id in (select id from breadcrumbs where is_seeded)');
    }
    await tx.query('update settings set content_rev = content_rev + 1, updated_at = now() where id = true');
  });
}
