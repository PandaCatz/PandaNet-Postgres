#!/usr/bin/env node
// Local dev launcher: brings up a real embedded PostgreSQL, then the server,
// so `node dev-start.mjs` gives a working stack with no database to install.
// Production uses DATABASE_URL against a real server and never runs this.
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PGPORT = +(process.env.PGPORT || 55440);
const PORT = process.env.PORT || '8325';

const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, '.pgdata-dev'),
  user: 'postgres', password: 'postgres', port: PGPORT, persistent: true,
});

let started = false;
try {
  await pg.initialise();          // throws if the data dir already exists
} catch { /* already initialised — reuse it so dev data survives restarts */ }
await pg.start();
started = true;
try { await pg.createDatabase('pandanet'); } catch { /* already there */ }

const url = `postgres://postgres:postgres@127.0.0.1:${PGPORT}/pandanet`;
console.log('dev postgres ready on ' + PGPORT);

const srv = spawn(process.execPath, [path.join(dir, 'server.js')], {
  env: {
    ...process.env,
    DATABASE_URL: url,
    PORT,
    ADMIN_KEY: process.env.ADMIN_KEY || 'dev-admin',
    SEED_KEY: process.env.SEED_KEY || 'dev-seed',
    PROXY_KEY: process.env.PROXY_KEY || 'dev-proxy',
  },
  stdio: 'inherit',
});

const shutdown = async () => {
  try { srv.kill(); } catch {}
  if (started) { try { await pg.stop(); } catch {} }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
srv.on('exit', shutdown);
