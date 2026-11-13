/**
 * Minimal migration runner: applies every .sql file in db/migrations in name
 * order, once, and records it in schema_migrations.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../api/_lib/db.js';

/** Thrown when the database was created by an earlier, incompatible version of the prototype. */
export class OldSchemaError extends Error {
  constructor() {
    super(
      'This database was created by an earlier version of the prototype (it still has hologram / hotspot / role columns). ' +
        'Run "npm run db:reset" to rebuild it from scratch. That deletes the old sessions and answers: export the CSV or run "npm run db:backup" first if you need them.',
    );
  }
}

/** The tables this app owns, children first, for "npm run db:reset". */
export const APP_TABLES = [
  'admin_actions',
  'behavior_events',
  'survey_responses',
  'settings',
  'helped_marks',
  'votes',
  'breadcrumbs',
  'audio_clips',
  'ghosts',
  'contributors',
  'sessions',
  'stations',
  'schema_migrations',
];

/** Drop everything this app created (and nothing else in the database). */
export async function dropAppTables(db: Db): Promise<void> {
  for (const table of APP_TABLES) await db.exec(`drop table if exists ${table} cascade`);
  await db.exec('drop sequence if exists guest_number_seq');
}

export async function runMigrations(db: Db, dir = join(process.cwd(), 'db', 'migrations')): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name));
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  // A database made by an earlier version of the prototype (hologram layers, hotspots, roles) cannot
  // be patched into this one: the breadcrumb model changed. Say so clearly instead of half-migrating.
  if (done.size > 0) {
    const old = await db.query(
      `select 1 from information_schema.columns
        where table_schema = current_schema()
          and ((table_name = 'breadcrumbs' and column_name in ('layer', 'hotspot')) or (table_name = 'sessions' and column_name = 'role'))
        limit 1`,
    );
    if (old.length > 0) throw new OldSchemaError();
  }
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    await db.tx(async (tx) => {
      await tx.exec(readFileSync(join(dir, file), 'utf8'));
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
