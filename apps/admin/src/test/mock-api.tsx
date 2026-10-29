import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { PREF_KEYS } from '../lib/prefs.js';
import { createAppRouter } from '../router.js';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (request: MockRequest) => Response;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An RFC 9457 answer shaped like apps/api/src/problem.ts. */
export function problem(
  status: number,
  code: string,
  title: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: `urn:muziris:problem:${code}`, title, status, code, ...extra }),
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

export const notSignedIn = () => problem(401, 'not_signed_in', 'Sign in to continue');

export const ADMIN = {
  id: '6f1d2c4e-0000-4000-8000-000000000001',
  realm: 'admin',
  email: 'asha@example.com',
  displayName: 'Asha Rao',
} as const;

/** Handlers for a signed-in admin holding `permissions`, with empty lists for side data. */
export function signedIn(permissions: string[]): Record<string, Handler> {
  return {
    'GET /auth/me': () => json({ user: ADMIN }),
    'GET /access/me': () => json({ permissions }),
    'GET /customers/groups': () => json({ customerGroups: [], nextAfter: null }),
  };
}

/**
 * Replaces fetch with a fake admin API. Keys are "METHOD /path" below /admin/v1; a request with
 * no handler gets a 404 problem. Returns every request made, in order.
 */
export function mockApi(handlers: Record<string, Handler>): MockRequest[] {
  const requests: MockRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost:5173');
      const request: MockRequest = {
        method: init.method ?? 'GET',
        path: url.pathname.replace(/^\/admin\/v1/, ''),
        query: url.searchParams,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      const handler = handlers[`${request.method} ${request.path}`];
      return Promise.resolve(
        handler ? handler(request) : problem(404, 'not_found', 'No such resource'),
      );
    }),
  );
  return requests;
}

/** Renders the whole admin app at `path`. */
export function renderApp(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

/** Browser storage may hold the UI preferences in prefs.ts and nothing else. */
export function expectOnlyPreferencesStored() {
  const allowed: string[] = Object.values(PREF_KEYS);
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
  expect(keys.filter((key) => key === null || !allowed.includes(key))).toEqual([]);
  expect(sessionStorage.length).toBe(0);
}

/** Every key and value in localStorage as one string, to check that no secret is in it. */
export function storedText(): string {
  return Array.from({ length: localStorage.length }, (_, i) => {
    const key = localStorage.key(i) ?? '';
    return `${key}=${localStorage.getItem(key) ?? ''}`;
  }).join('\n');
}
