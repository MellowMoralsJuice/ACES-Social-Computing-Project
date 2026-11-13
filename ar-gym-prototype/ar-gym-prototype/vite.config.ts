/**
 * Vite config.
 *
 * In production Vercel serves the built React app and runs each file in /api
 * as a serverless function. For local development the small plugin below
 * mounts those same /api handlers on Vite's dev server, so `npm run dev`
 * starts the whole stack with one command:
 *
 *   - DATABASE_URL set (in .env.local)  -> talks to that Postgres / Supabase
 *   - DATABASE_URL not set              -> starts the built-in local database,
 *                                          migrates and seeds it automatically
 *
 * `npm run dev:https` serves over HTTPS on your LAN (self-signed certificate)
 * so a phone on the same wifi can use its camera.
 */
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function localApi(): Plugin {
  return {
    name: 'ar-gym-local-api',
    apply: 'serve',
    async configureServer(server) {
      // Make every variable from .env / .env.local visible to the API code.
      const env = loadEnv(server.config.mode, process.cwd(), '');
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      if (!process.env.DATABASE_URL) {
        const { startLocalDb } = (await server.ssrLoadModule('/scripts/local-db.ts')) as typeof import('./scripts/local-db');
        await startLocalDb(join(process.cwd(), '.localdb'));
        server.config.logger.info('\n  Local database ready (.localdb). Admin PIN: ' + (process.env.ADMIN_PIN ?? '2468') + '\n');
      }

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith('/api/')) return next();
        const name = path.replace(/^\/api\//, '').replace(/\/$/, '');
        const file = `/api/${name}.ts`;
        if (!/^[a-z0-9/-]+$/.test(name) || name.includes('_lib') || !existsSync(join(process.cwd(), file))) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such API route.' } }));
          return;
        }
        try {
          const module = (await server.ssrLoadModule(file)) as { default: ApiHandler };
          await module.default(req, res);
        } catch (error) {
          server.config.logger.error(String(error instanceof Error ? error.stack : error));
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: { code: 'server_error', message: 'Local API error. Check the terminal.' } }));
          }
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // The local API (and its database) must not start when Vitest loads this config.
  plugins: [react(), ...(process.env.VITEST ? [] : [localApi()]), ...(mode === 'https' ? [basicSsl()] : [])],
  server: { port: 5173 },
  build: { target: 'es2020', sourcemap: false },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
}));
