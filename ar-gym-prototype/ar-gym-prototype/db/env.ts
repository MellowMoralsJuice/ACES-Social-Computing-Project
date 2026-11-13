/** Loads .env.local then .env into process.env for the db scripts (no dependency needed). */
import { existsSync, readFileSync } from 'node:fs';

export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!match || line.trim().startsWith('#')) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}

export function requireDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'Copy .env.example to .env.local and paste the Supabase pooled connection string,\n' +
        'or just run "npm run dev" to use the built-in local database (no setup needed).',
    );
    process.exit(1);
  }
}
