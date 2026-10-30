import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ShellResult } from '../operations/generated.js';
import { createAppRouter } from '../router.js';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  /** For a GraphQL request: the operation name and variables from the query string. */
  operationName?: string;
  variables?: Record<string, unknown>;
}

type Handler = (request: MockRequest) => Response;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An RFC 9457 answer shaped like apps/api/src/problem.ts. */
export function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({ type: `urn:muziris:problem:${code}`, title, status, code }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const notSignedIn = () => problem(401, 'not_signed_in', 'Sign in to continue');

/** A GraphQL answer with data, and optionally field errors. */
export function data(body: object, errors?: unknown[]): Response {
  return json(errors ? { data: body, errors } : { data: body });
}

export const SHELL: ShellResult = {
  viewer: {
    id: 'b1',
    displayName: 'Ravi Menon',
    email: 'ravi@kochi-traders.example',
    customer: { id: 'c1', name: 'Kochi Traders' },
  },
  website: { code: 'main', name: 'Muziris Trade', currency: 'INR', locale: 'en-IN' },
  categories: [
    { id: 'fasteners', name: 'Fasteners', parentId: null, position: 1 },
    { id: 'bolts', name: 'Bolts', parentId: 'fasteners', position: 1 },
    { id: 'hex', name: 'Hex bolts', parentId: 'bolts', position: 1 },
    { id: 'tools', name: 'Hand tools', parentId: null, position: 2 },
  ],
};

export const ROW = {
  id: 'p1',
  sku: 'HB-M8-40',
  name: 'Hex bolt M8 × 40, zinc plated',
  category: { id: 'hex', name: 'Hex bolts' },
  primaryUnit: { code: 'EA', name: 'Each', precision: 0 },
  price: { unitPrice: { amount: '12.50', currency: 'INR' }, unitCode: 'EA' },
} as const;

/** Handlers for a signed-in buyer: the Shell operation answers with SHELL. */
export function signedIn(): Record<string, Handler> {
  return { 'GraphQL Shell': () => data(SHELL) };
}

/**
 * Replaces fetch with a fake storefront API. Keys are "METHOD /path" below /storefront/v1, or
 * "GraphQL <operationName>" for a GraphQL request. A request with no handler gets a 404 problem.
 * Returns every request made, in order.
 */
export function mockApi(handlers: Record<string, Handler>): MockRequest[] {
  const requests: MockRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost:5174');
      const path = url.pathname.replace(/^\/storefront\/v1/, '');
      const operationName = url.searchParams.get('operationName') ?? undefined;
      const variables = url.searchParams.get('variables');
      const request: MockRequest = {
        method: init.method ?? 'GET',
        path,
        query: url.searchParams,
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        ...(operationName === undefined ? {} : { operationName }),
        ...(variables === null
          ? {}
          : { variables: JSON.parse(variables) as Record<string, unknown> }),
      };
      requests.push(request);
      const handler =
        path === '/graphql' && operationName !== undefined
          ? handlers[`GraphQL ${operationName}`]
          : handlers[`${request.method} ${path}`];
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      return Promise.resolve(
        handler ? handler(request) : problem(404, 'not_found', 'No such resource'),
      );
    }),
  );
  return requests;
}

/** Renders the whole storefront at `path`. */
export function renderApp(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}
