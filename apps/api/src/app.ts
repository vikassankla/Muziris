import type { Database } from '@muziris/db';
import { mailConfigFromEnv, type MailConfig } from '@muziris/notifications';
import type { TaxProvider } from '@muziris/orders';
import { configuredMethods, type GatewayClients, type PaymentGateways } from '@muziris/payments';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { except } from 'hono/combine';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { accessRoutes } from './access-routes.js';
import { authRoutes } from './auth-routes.js';
import { catalogRoutes } from './catalog-routes.js';
import { customerRoutes } from './customer-routes.js';
import { createEmails } from './emails.js';
import { notificationRoutes } from './notification-routes.js';
import { orderRoutes } from './order-routes.js';
import { LARGE_BODY_PATH, pricingRoutes } from './pricing-routes.js';
import { searchRoutes } from './search-routes.js';
import { settingRoutes } from './setting-routes.js';
import { shoppingListRoutes } from './shopping-list-routes.js';
import { taxRoutes } from './tax-routes.js';
import { storefrontRoutes, WEBSITE_HEADER, type StorefrontOptions } from './storefront/routes.js';
import { visibilityRoutes } from './visibility-routes.js';
import { webhookRoutes } from './webhook-routes.js';
import { websiteRoutes } from './website-routes.js';
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
  /** Persisted queries and whether ad hoc queries run; by default neither (ADR 0014). */
  storefront?: StorefrontOptions;
  /**
   * The tax calculator checkout uses: the server passes the tax engine's (ADR 0017). Without
   * one checkout refuses with TAX_NOT_CONFIGURED, so no order is placed without tax.
   */
  tax?: TaxProvider;
  /**
   * The payment gateways configured from the environment (ADR 0019) and their clients. Without
   * them checkout offers payment terms only, and the webhooks answer 404.
   */
  payments?: { gateways: PaymentGateways; clients: GatewayClients };
  /**
   * Mail configuration (ADR 0020) and the code of the website the storefront serves, whose
   * name, locale and time zone invitations use. Development defaults when omitted.
   */
  mail?: MailConfig;
  storefrontWebsite?: string;
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
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Request-Id',
        WEBSITE_HEADER,
      ],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      credentials: true,
      maxAge: 600,
    }),
  );

  // A price import takes up to 2 MB of CSV and sets its own limit (ADR 0022).
  const limitBody = bodyLimit({
    maxSize: deps.maxBodyBytes,
    onError: () => {
      throw new HttpProblem(413, 'payload_too_large', 'The request body is too large');
    },
  });
  app.use(
    '*',
    except((c) => LARGE_BODY_PATH.test(c.req.path), limitBody),
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
  const emails = createEmails({
    db: deps.db,
    logger: deps.logger,
    mail: deps.mail ?? mailConfigFromEnv({}, { production: false }),
    storefrontWebsite: deps.storefrontWebsite ?? 'main',
  });
  const emailDeps = { ...authDeps, emails, storefrontWebsite: deps.storefrontWebsite ?? 'main' };
  app.route('/admin/v1/auth', authRoutes('admin', authDeps));
  app.route('/storefront/v1/auth', authRoutes('buyer', authDeps));
  app.route(
    '/storefront/v1/graphql',
    storefrontRoutes({
      ...authDeps,
      storefront: deps.storefront ?? { persistedQueries: new Map(), allowAdhocQueries: false },
      checkout:
        deps.tax === undefined
          ? null
          : {
              tax: deps.tax,
              paymentMethods: configuredMethods(deps.payments?.gateways ?? {}),
            },
      ...(deps.payments ? { payments: deps.payments.clients } : {}),
      emails,
    }),
  );
  app.route('/webhooks', webhookRoutes({ ...emailDeps, gateways: deps.payments?.gateways ?? {} }));
  app.route('/admin/v1/access', accessRoutes(authDeps));
  app.route('/admin/v1/catalog', catalogRoutes(authDeps));
  app.route('/admin/v1/customers', customerRoutes(emailDeps));
  app.route('/admin/v1/notifications', notificationRoutes(authDeps));
  app.route('/admin/v1/orders', orderRoutes(emailDeps));
  app.route('/admin/v1/pricing', pricingRoutes(authDeps));
  app.route('/admin/v1/search', searchRoutes(authDeps));
  app.route('/admin/v1/settings', settingRoutes(authDeps));
  app.route('/admin/v1/tax', taxRoutes(authDeps));
  app.route('/admin/v1/shopping-lists', shoppingListRoutes(authDeps));
  app.route('/admin/v1/visibility', visibilityRoutes(authDeps));
  app.route('/admin/v1/websites', websiteRoutes(authDeps));

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
