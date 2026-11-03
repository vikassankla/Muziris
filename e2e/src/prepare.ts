/**
 * Makes the journeys' database from nothing, as an install does (docs/install.md): migrations,
 * `setup` and `admin:create` through their commands, then the shared world. Runs before the API
 * starts (playwright.config.ts).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations } from '@muziris/db';
import postgres from 'postgres';
import { ADMIN_EMAIL, e2eDatabaseUrl, PASSWORD } from './env.js';
import { seedWorld } from './world.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const url = e2eDatabaseUrl();
const server = new URL(url);
server.pathname = '/postgres';
const admin = postgres(server.toString(), { max: 1, onnotice: () => undefined });
try {
  // The name is fixed in env.ts, so it is safe in an identifier.
  await admin.unsafe('drop database if exists muziris_e2e with (force)');
  await admin.unsafe('create database muziris_e2e');
} finally {
  await admin.end({ timeout: 5 });
}

await runMigrations(url);

const env = { ...process.env, DATABASE_URL: url };
const api = (args: string[], input?: string) =>
  execFileSync('pnpm', ['--silent', '--filter', '@muziris/api', 'run', ...args], {
    cwd: ROOT,
    env,
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
api(['setup', '--organization', 'Muziris Industrial']);
api(['admin:create', '--email', ADMIN_EMAIL, '--name', 'Meera Iyer'], PASSWORD);

const database = createDatabase({ url, maxConnections: 2, applicationName: 'muziris-e2e' });
try {
  await seedWorld(database.db);
} finally {
  await database.close();
}
