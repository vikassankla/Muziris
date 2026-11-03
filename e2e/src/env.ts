// Where the journeys run (ADR 0024). The ports keep clear of the dev servers (4000, 5173, 5174)
// and the Docker stack (8080, 8081), so all of them can run side by side.

export const API_PORT = 4100;
export const ADMIN_PORT = 4180;
export const STOREFRONT_PORT = 4181;

export const API_URL = `http://127.0.0.1:${API_PORT}`;
// localhost, not 127.0.0.1: the browser treats it as secure, so the __Host- cookies are kept.
export const ADMIN_URL = `http://localhost:${ADMIN_PORT}`;
export const STOREFRONT_URL = `http://localhost:${STOREFRONT_PORT}`;

/** The storefront build serves this website (VITE_STOREFRONT_WEBSITE). */
export const WEBSITE_CODE = 'main';

/** Mailpit's HTTP API, which reads what the API sent to its SMTP port. */
export const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
export const SMTP_URL = process.env['E2E_SMTP_URL'] ?? 'smtp://127.0.0.1:1025';

/** A test password for the admin and the buyers this suite creates in its own database. */
export const PASSWORD = 'correct horse battery staple';
export const ADMIN_EMAIL = 'meera@muziris.example';

/**
 * The journeys' own database, muziris_e2e, dropped and created again on every run. It is on the
 * server of E2E_DATABASE_URL, or else of TEST_DATABASE_URL, whose database is left alone.
 */
export function e2eDatabaseUrl(): string {
  const base = process.env['E2E_DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'];
  if (base === undefined || base === '') {
    throw new Error('Set E2E_DATABASE_URL or TEST_DATABASE_URL to a PostgreSQL server');
  }
  const url = new URL(base);
  url.pathname = '/muziris_e2e';
  return url.toString();
}
