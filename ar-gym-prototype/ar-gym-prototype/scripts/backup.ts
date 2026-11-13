/**
 * npm run db:backup — dump every table to backups/<timestamp>.json.
 * Run it before and after each class session. (Restoring is a matter of
 * re-inserting rows; for a full SQL dump use `pg_dump "$DIRECT_URL"`.)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, getDb } from '../api/_lib/db.js';
import { loadEnv, requireDatabaseUrl } from '../db/env.js';

const TABLES = [
  'stations',
  'sessions',
  'contributors',
  'breadcrumbs',
  'audio_clips',
  'votes',
  'helped_marks',
  'settings',
  'survey_responses',
  'behavior_events',
  'admin_actions',
];

loadEnv();
requireDatabaseUrl();
const db = getDb();
const dump: Record<string, unknown[]> = {};
for (const table of TABLES) {
  // Table names come from the fixed list above, never from input.
  dump[table] = await db.query(`select * from ${table}`);
  console.log(`${table}: ${dump[table].length} rows`);
}
mkdirSync('backups', { recursive: true });
const file = join('backups', `ar-gym-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ exported_at: new Date().toISOString(), tables: dump }, null, 2));
console.log(`Saved ${file}`);
await closeDb();
