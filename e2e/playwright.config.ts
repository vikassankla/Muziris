import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import {
  ADMIN_PORT,
  ADMIN_URL,
  API_PORT,
  API_URL,
  e2eDatabaseUrl,
  SMTP_URL,
  STOREFRONT_PORT,
  STOREFRONT_URL,
  WEBSITE_CODE,
} from './src/env.js';

// End-to-end journeys (ADR 0024): the built admin app and storefront, served by `vite preview`
// behind their API proxies as nginx serves them in Docker, the real API, and a database made
// fresh on every run. Run from the repository root with `pnpm e2e`.

const CI = process.env['CI'] !== undefined;
const ROOT = '..';

const apiEnv = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  DATABASE_URL: e2eDatabaseUrl(),
  CORS_ORIGINS: `${ADMIN_URL},${STOREFRONT_URL}`,
  TRUSTED_PROXY_HOPS: '0',
  // As in production: the storefront runs its persisted queries only.
  STOREFRONT_ADHOC_QUERIES: 'deny',
  STOREFRONT_PERSISTED_QUERIES: '../storefront/persisted-queries.json',
  STOREFRONT_WEBSITE: WEBSITE_CODE,
  STOREFRONT_PUBLIC_URL: STOREFRONT_URL,
  SMTP_URL,
  MAIL_FROM: 'Muziris <no-reply@muziris.localhost>',
  // A key of its own for every run (ADR 0026): the run's database is new too.
  ADMIN_TOTP_KEY: randomBytes(32).toString('base64'),
};

const appEnv = { MUZIRIS_API_TARGET: API_URL, VITE_STOREFRONT_WEBSITE: WEBSITE_CODE };

/** Builds one app and serves the build on its port, proxying its API path to the API. */
function app(name: 'admin' | 'storefront', port: number, url: string) {
  return {
    command:
      `pnpm --filter @muziris/${name} build && ` +
      `pnpm --filter @muziris/${name} exec vite preview --host localhost --port ${port} --strictPort`,
    cwd: ROOT,
    url,
    env: appEnv,
    timeout: 180_000,
    reuseExistingServer: false,
  };
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Locally, Playwright's default: half the CPU cores.
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  webServer: [
    {
      // The database first, then the API on it.
      command: 'pnpm exec tsx src/prepare.ts && pnpm --filter @muziris/api start',
      cwd: '.',
      url: `${API_URL}/health/ready`,
      env: apiEnv,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    app('admin', ADMIN_PORT, ADMIN_URL),
    app('storefront', STOREFRONT_PORT, STOREFRONT_URL),
  ],
  projects: [
    { name: 'admin sign-in', testMatch: /admin\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['admin sign-in'],
    },
  ],
});
