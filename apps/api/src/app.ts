import type { Database } from '@muziris/db';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { accessRoutes } from './access-routes.js';
import { authRoutes } from './auth-routes.js';
import { catalogRoutes } from './catalog-routes.js';
import { resolveClientIp } from './client-ip.js';
import type { Logger } from './logger.js';
import { HttpProblem, problemResponse, toProblem } from './problem.js';

export interface AppDependencies {
  logger: Logger;
  db: Database;
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
  corsOrigins: readonly string[];
  maxBodyBytes: number;
  /** How long a readiness check may wait for the database. */
  readinessTimeoutMs?: number;
  /** Number of reverse proxies in front of the API whose X-Forwarded-For can be trusted. */
  trustedProxyHops?: number;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Client IP resolver, injectable for tests. */
  clientIp?: (c: Context) => string | undefined;
}

export interface AppEnv {
  Variables: { requestId: string };
}

// Request ids from clients are accepted only in a safe shape, so they cannot inject into logs.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const allowedOrigins = new Set(deps.corsOrigins);

  app.use(
    '*',
    requestId({
      generator: () => crypto.randomUUID(),
      limitLength: 128,
    }),
  );
  app.use('*', async (c, next) => {
    // Replace a client-supplied id that is not in the safe shape.
    if (!REQUEST_ID_PATTERN.test(c.get('requestId'))) {
      c.set('requestId', crypto.randomUUID());
      c.header('X-Request-Id', c.get('requestId'));
    }
    await next();
  });

  // Access log: method, path and status only. Query strings and bodies are never logged.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  app.use(
    '*',
    secureHeaders({
      // The API serves JSON only, so the strictest policy applies.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy: 'no-referrer',
    }),
  );

  app.use(
    '*',
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use(
    '*',
    bodyLimit({
      maxSize: deps.maxBodyBytes,
      onError: () => {
        throw new HttpProblem(413, 'payload_too_large', 'The request body is too large');
      },
    }),
  );

  app.get('/health/live', (c) => c.json({ status: 'ok' }));

  app.get('/health/ready', async (c) => {
    try {
      await withTimeout(deps.pingDatabase(), deps.readinessTimeoutMs ?? 2000);
      return c.json({ status: 'ok', checks: { database: 'ok' } });
    } catch (error) {
      deps.logger.warn({ requestId: c.get('requestId'), err: error }, 'readiness check failed');
      // The reason stays in the logs; callers only learn which dependency is down.
      return c.json({ status: 'unavailable', checks: { database: 'unavailable' } }, 503);
    }
  });

  const authDeps = {
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    clientIp: deps.clientIp ?? ((c: Context) => resolveClientIp(c, deps.trustedProxyHops ?? 0)),
    trustedOrigins: allowedOrigins,
  };
  app.route('/admin/v1/auth', authRoutes('admin', authDeps));
  app.route('/storefront/v1/auth', authRoutes('buyer', authDeps));
  app.route('/admin/v1/access', accessRoutes(authDeps));
  app.route('/admin/v1/catalog', catalogRoutes(authDeps));

  app.notFound((c) =>
    problemResponse(c, toProblem(c, new HttpProblem(404, 'not_found', 'No such resource'))),
  );

  app.onError((error, c) => {
    const problem = toProblem(c, error);
    if (problem.status >= 500) {
      deps.logger.error({ requestId: c.get('requestId'), err: error }, 'unhandled error');
    }
    return problemResponse(c, problem);
  });

  return app;
}
