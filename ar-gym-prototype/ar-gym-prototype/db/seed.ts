/**
 * npm run db:seed      — insert the seeded station and breadcrumbs if missing.
 * npm run db:reseed    — also restore every seeded breadcrumb to its starting state.
 */
import { closeDb, getDb } from '../api/_lib/db.js';
import { applySeed } from '../api/_lib/seed.js';
import { SEED_BREADCRUMBS } from '../shared/seed.js';
import { loadEnv, requireDatabaseUrl } from './env.js';

loadEnv();
requireDatabaseUrl();
const restore = process.argv.includes('--restore');
await applySeed(getDb(), { restore });
console.log(`Seed ${restore ? 'restored' : 'applied'}: 1 station, ${SEED_BREADCRUMBS.length} breadcrumbs (4 text, 2 audio).`);
await closeDb();
