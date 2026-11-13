/** npm run db:migrate — apply SQL migrations to the database in DATABASE_URL. */
import { closeDb, getDb } from '../api/_lib/db.js';
import { loadEnv, requireDatabaseUrl } from './env.js';
import { OldSchemaError, runMigrations } from './migrations.js';

loadEnv();
requireDatabaseUrl();
try {
  const applied = await runMigrations(getDb());
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is already up to date.');
} catch (error) {
  if (!(error instanceof OldSchemaError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
await closeDb();
