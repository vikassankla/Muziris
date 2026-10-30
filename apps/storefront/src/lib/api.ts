import { z } from 'zod';
import type { Operation } from './graphql.js';

/** Every storefront endpoint lives under this prefix; the dev server proxies it to the API. */
export const API_PREFIX = '/storefront/v1';

/** What the buyer sees for any server failure, whatever the server said. */
export const SERVER_ERROR_TITLE = "We couldn't load this page";

/**
 * The website this build serves (ADR 0015), sent in the Muziris-Website header. Set
 * VITE_STOREFRONT_WEBSITE to a website code in the repository's .env.
 */
const configuredWebsite = import.meta.env['VITE_STOREFRONT_WEBSITE'] as string | undefined;
export const WEBSITE_CODE: string | undefined =
  configuredWebsite === '' ? undefined : configuredWebsite;

/**
 * A refused request. `code` is the API's stable code to branch on; `title` is safe to show.
 * For a server failure the title is fixed and nothing the server said reaches the page.
 */
export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly requestId: string | undefined;
  /** The GraphQL path of a field error, such as ["product", "price"]. */
  readonly path: readonly (string | number)[] | undefined;

  constructor(init: {
    status: number;
    code: string;
    title: string;
    requestId?: string | undefined;
    path?: readonly (string | number)[] | undefined;
  }) {
    super(init.title);
    this.name = 'ApiProblem';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.requestId = init.requestId;
    this.path = init.path;
  }
}

export function isApiProblem(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem;
}

const problemSchema = z.object({
  code: z.string(),
  title: z.string(),
  requestId: z.string().optional(),
});

const graphqlErrorSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  extensions: z.object({ code: z.string() }).catchall(z.unknown()),
});

const graphqlResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(graphqlErrorSchema).optional(),
});

/** Codes whose message the API wrote for the buyer (ADR 0014); every other message is hidden. */
const SAFE_CODES = new Set(['BAD_USER_INPUT']);

function networkProblem(): ApiProblem {
  return new ApiProblem({
    status: 0,
    code: 'network_error',
    title: "We couldn't reach the shop. Check your connection and try again.",
  });
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_PREFIX}${path}`, { credentials: 'same-origin', ...init });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw networkProblem();
  }
}

async function refused(response: Response): Promise<ApiProblem> {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  const body: unknown = await response.json().catch(() => undefined);
  const problem = problemSchema.safeParse(body);
  if (response.status < 500 && problem.success) {
    return new ApiProblem({
      status: response.status,
      code: problem.data.code,
      title: problem.data.title,
      requestId: problem.data.requestId ?? requestId,
    });
  }
  // A GraphQL request error (400) or a server failure: the page shows the fixed message.
  const graphql = graphqlResponseSchema.safeParse(body);
  const code = graphql.success
    ? (graphql.data.errors?.[0]?.extensions.code ?? 'server_error')
    : 'server_error';
  return new ApiProblem({ status: response.status, code, title: SERVER_ERROR_TITLE, requestId });
}

/**
 * Runs a persisted operation (ADR 0015): a GET with the operation's hash and variables, never
 * its text. Resolves with the data when every field answered; a field error rejects with an
 * ApiProblem carrying its code and path, so a caller can show BAD_USER_INPUT next to its field.
 */
export async function runOperation<TResult, TVariables>(
  operation: Operation<TResult, TVariables>,
  variables: TVariables,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<TResult> {
  if (WEBSITE_CODE === undefined) {
    throw new ApiProblem({ status: 0, code: 'website_not_configured', title: SERVER_ERROR_TITLE });
  }
  const params = new URLSearchParams({
    operationName: operation.name,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: operation.hash } }),
  });
  const response = await send(`/graphql?${params.toString()}`, {
    headers: { accept: 'application/json', 'Muziris-Website': WEBSITE_CODE },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await refused(response);

  const requestId = response.headers.get('x-request-id') ?? undefined;
  const parsed = graphqlResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success || !parsed.data.data) {
    throw new ApiProblem({
      status: response.status,
      code: 'unexpected_response',
      title: SERVER_ERROR_TITLE,
      requestId,
    });
  }
  const [first] = parsed.data.errors ?? [];
  if (first) {
    const code = first.extensions.code;
    throw new ApiProblem({
      status: response.status,
      code,
      title: SAFE_CODES.has(code) ? first.message : SERVER_ERROR_TITLE,
      requestId,
      path: first.path,
    });
  }
  // The API answered this exact document, whose types generated.ts holds.
  return parsed.data.data as TResult;
}

const buyerSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
});

export type Buyer = z.output<typeof buyerSchema>['user'];

/** Signs a buyer in. The session is an HttpOnly cookie; the app never sees a token. */
export async function signIn(email: string, password: string): Promise<Buyer> {
  const response = await send('/auth/sign-in', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw await refused(response);
  const parsed = buyerSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiProblem({
      status: response.status,
      code: 'unexpected_response',
      title: SERVER_ERROR_TITLE,
    });
  }
  return parsed.data.user;
}

export async function signOut(): Promise<void> {
  const response = await send('/auth/sign-out', { method: 'POST' });
  if (!response.ok && response.status !== 401) throw await refused(response);
}
