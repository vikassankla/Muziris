import { z } from 'zod';

/** Every admin endpoint lives under this prefix; the dev server proxies it to the API. */
export const API_PREFIX = '/admin/v1';

/** What the admin sees for any 5xx, whatever the server said. Details stay in the API logs. */
export const SERVER_ERROR_TITLE = 'Something went wrong on our side';

/** RFC 9457 problem details as the API sends them (apps/api/src/problem.ts). */
const problemSchema = z.object({
  title: z.string(),
  status: z.number(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

/**
 * A refused API request. `code` is the API's stable code to branch on; `title` is safe to show.
 * For a 5xx the title is replaced and the detail dropped, so server internals never reach the UI.
 */
export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  readonly errors: readonly { path: string; message: string }[];
  /** From Retry-After, when the API sent one (sign-in rate limits). */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: string;
    title: string;
    detail?: string | undefined;
    requestId?: string | undefined;
    errors?: readonly { path: string; message: string }[] | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.title);
    this.name = 'ApiProblem';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.errors = init.errors ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiProblem(error: unknown): error is ApiProblem {
  return error instanceof ApiProblem;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value);
}

async function problemFrom(response: Response): Promise<ApiProblem> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = problemSchema.safeParse(body);
  const requestId = parsed.success
    ? parsed.data.requestId
    : (response.headers.get('x-request-id') ?? undefined);
  if (response.status >= 500 || !parsed.success) {
    return new ApiProblem({
      status: response.status,
      code: parsed.success ? parsed.data.code : 'unexpected_response',
      title: response.status >= 500 ? SERVER_ERROR_TITLE : 'The server sent an unexpected answer',
      requestId,
    });
  }
  return new ApiProblem({
    status: response.status,
    code: parsed.data.code,
    title: parsed.data.title,
    detail: parsed.data.detail,
    requestId,
    errors: parsed.data.errors,
    retryAfterSeconds: retryAfter(response),
  });
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
}

/**
 * Calls the admin API and validates the answer with `schema`. The session lives in an
 * HttpOnly cookie the browser sends by itself; the app never sees or stores a token.
 */
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const search = params.size > 0 ? `?${params.toString()}` : '';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}${search}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiProblem({
      status: 0,
      code: 'network_error',
      title: 'The API could not be reached. Check your connection and try again.',
    });
  }

  if (!response.ok) throw await problemFrom(response);
  if (response.status === 204) return schema.parse(undefined);
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiProblem({
      status: response.status,
      code: 'unexpected_response',
      title: 'The server sent an unexpected answer',
    });
  }
  return parsed.data;
}
