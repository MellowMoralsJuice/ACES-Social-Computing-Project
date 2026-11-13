/**
 * npm run db:reset — rebuild the database in DATABASE_URL from scratch.
 *
 * Use this once when moving from an earlier version of the prototype (the
 * breadcrumb model changed, so old databases cannot be patched). It drops only
 * the tables this app created, then migrates and seeds. Old sessions, answers
 * and the event log are deleted: export the CSV or run "npm run db:backup" first.
 */
import { closeDb, getDb } from '../api/_lib/db.js';
import { applySeed } from '../api/_lib/seed.js';
import { SEED_BREADCRUMBS } from '../shared/seed.js';
import { loadEnv, requireDatabaseUrl } from './env.js';
import { dropAppTables, runMigrations } from './migrations.js';

loadEnv();
requireDatabaseUrl();
if (!process.argv.includes('--yes')) {
  console.error('This deletes every session, answer and breadcrumb in the database.\nRun it again as:  npm run db:reset -- --yes');
  process.exit(1);
}
const db = getDb();
await dropAppTables(db);
const applied = await runMigrations(db);
await applySeed(db);
console.log(`Rebuilt. Applied: ${applied.join(', ')}. Seeded ${SEED_BREADCRUMBS.length} breadcrumbs.`);
await closeDb();
