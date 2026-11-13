/**
 * Zero-setup local database for `npm run dev` and the tests: PGlite, a real
 * Postgres compiled to WebAssembly that runs inside Node. Same SQL, same
 * migrations and seed as Supabase. It is a devDependency and is never loaded
 * in production.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Db, Row } from '../api/_lib/db.js';
import { applySeed } from '../api/_lib/seed.js';
import { OldSchemaError, dropAppTables, runMigrations } from '../db/migrations.js';

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(text: string): Promise<unknown>;
}

function wrap(target: Queryable, transaction?: PGlite['transaction']): Db {
  return {
    async query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await target.query(text, params)).rows as T[];
    },
    async exec(text: string): Promise<void> {
      await target.exec(text);
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (!transaction) return fn(this); // already inside a transaction
      return (await transaction((tx) => fn(wrap(tx as unknown as Queryable)))) as T;
    },
  };
}

/**
 * Start the local database, migrate, seed, and register it for the API.
 * @param dataDir folder to persist to; omit for a throwaway in-memory database (tests).
 */
export async function startLocalDb(dataDir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const db = wrap(pg as unknown as Queryable, pg.transaction.bind(pg) as PGlite['transaction']);
  try {
    await runMigrations(db);
  } catch (error) {
    if (!(error instanceof OldSchemaError)) throw error;
    // The local database is a scratch copy: one made by an earlier version is simply rebuilt.
    console.log('\n  Local database was made by an earlier version of the prototype: rebuilding it.\n');
    await dropAppTables(db);
    await runMigrations(db);
  }
  await applySeed(db);
  globalThis.__AR_GYM_DB__ = db;
  return {
    db,
    close: async () => {
      globalThis.__AR_GYM_DB__ = undefined;
      await pg.close();
    },
  };
}
