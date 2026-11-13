/**
 * Database access. One tiny interface, two drivers:
 *
 *  - Production / Supabase: postgres.js over the POOLED connection string
 *    (DATABASE_URL). Serverless-friendly: one connection per function
 *    instance, no prepared statements (required by the transaction pooler),
 *    short idle timeout.
 *  - Local dev and tests: an embedded Postgres registered on globalThis by
 *    scripts/local-db.ts, so `npm run dev` works with zero configuration.
 *
 * Every query is parameterized ($1, $2, ...). Nothing is ever interpolated
 * into SQL text.
 */
import postgres from 'postgres';

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run a script of several statements with no parameters (migrations only). */
  exec(text: string): Promise<void>;
  /** Run `fn` inside one transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

declare global {
  var __AR_GYM_DB__: Db | undefined;
}

type Sql = ReturnType<typeof postgres>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Unsafe = { unsafe: (text: string, params?: any[]) => PromiseLike<unknown> };

let cached: Db | null = null;
let pool: Sql | null = null;

function wrap(sql: Unsafe, begin?: Sql['begin']): Db {
  return {
    async query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
      return Array.from(rows);
    },
    async exec(text: string): Promise<void> {
      await sql.unsafe(text);
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (!begin) return fn(this); // already inside a transaction
      return (await begin((tx) => fn(wrap(tx as unknown as Unsafe)))) as T;
    },
  };
}

export function getDb(): Db {
  if (globalThis.__AR_GYM_DB__) return globalThis.__AR_GYM_DB__;
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add the Supabase pooled connection string (see .env.example).');
  }
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || url.includes('host=/');
  const sql = postgres(url, {
    prepare: false, // Supabase transaction pooler does not keep prepared statements
    max: 1, // one connection per short-lived function instance
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: isLocal ? false : 'require',
    onnotice: () => {},
  });
  pool = sql;
  cached = wrap(sql as unknown as Unsafe, sql.begin.bind(sql) as Sql['begin']);
  return cached;
}

/** Close the pool (scripts only). */
export async function closeDb(): Promise<void> {
  const open = pool;
  cached = null;
  pool = null;
  if (open) await open.end({ timeout: 5 });
}
