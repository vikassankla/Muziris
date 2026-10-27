import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

/**
 * Error responses follow RFC 9457 (application/problem+json). Clients get a stable `code`
 * to branch on; internal details and stack traces never leave the server.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

/** An error that is safe to show to the caller as-is. */
export class HttpProblem extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly title: string;

  constructor(status: ContentfulStatusCode, code: string, title: string, detail?: string) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export function problemResponse(c: Context, problem: Problem): Response {
  return c.body(JSON.stringify(problem), problem.status as ContentfulStatusCode, {
    'content-type': 'application/problem+json; charset=utf-8',
  });
}

function base(c: Context, status: number, code: string, title: string): Problem {
  const requestId = c.get('requestId') as string | undefined;
  return {
    type: `urn:muziris:problem:${code}`,
    title,
    status,
    code,
    instance: c.req.path,
    ...(requestId ? { requestId } : {}),
  };
}

export function toProblem(c: Context, error: unknown): Problem {
  if (error instanceof HttpProblem) {
    return { ...base(c, error.status, error.code, error.title), detail: error.message };
  }
  if (error instanceof ZodError) {
    return {
      ...base(c, 400, 'validation_failed', 'The request is not valid'),
      errors: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }
  return base(c, 500, 'internal_error', 'Something went wrong on our side');
}
