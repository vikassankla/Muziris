import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  adminSearchQuerySchema,
  getBuildState,
  MAX_QUERY_LENGTH,
  searchProducts,
} from '@muziris/search';
import type { JobQueue } from '@muziris/jobs';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';

export interface SearchRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  jobs: JobQueue;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface SearchEnv {
  Variables: AdminAccessVariables;
}

/** Query strings carry text only; this turns page numbers into numbers. */
const wholeNumber = z
  .string()
  .regex(/^\d{1,4}$/, 'Use a whole number')
  .transform(Number)
  .optional();

const productsQuery = z
  .object({
    // The module trims and checks the length again; this only bounds what is read.
    q: z.string().max(MAX_QUERY_LENGTH * 2),
    limit: wholeNumber,
    offset: wholeNumber,
    status: z.string().max(20).optional(),
  })
  .transform((q) =>
    adminSearchQuerySchema.parse(
      Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)),
    ),
  );

/**
 * Admin product search and the search build, under /admin/v1/search (ADR 0013). Buyer search
 * is not routed here; the storefront API calls searchProductsForBuyer.
 */
export function searchRoutes(deps: SearchRouteDependencies): Hono<SearchEnv> {
  const app = new Hono<SearchEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  /** Every product, ranked, a page at a time. The query string is never logged. */
  app.get('/products', need('product.view'), async (c) =>
    c.json(await searchProducts(deps.db, productsQuery.parse(c.req.query()))),
  );

  /** How many products wait for the index, and what the last full build did. */
  app.get('/build', need('product.view'), async (c) => {
    const [state, job] = await Promise.all([
      getBuildState(deps.db),
      deps.jobs.status('search.build'),
    ]);
    return c.json({ build: { ...state, job } });
  });

  /**
   * Queues a rebuild of the whole index (ADR 0013, 0025); the worker runs it within seconds. The
   * catalog routes keep reindexing one product at a time, so this is for changes made elsewhere.
   */
  app.post('/build', need('product.manage'), async (c) => {
    await deps.jobs.enqueue('search.build');
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id },
      'search.build_queued',
    );
    return c.json({ build: { job: await deps.jobs.status('search.build') } }, 202);
  });

  return app;
}
