import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  adminSearchQuerySchema,
  getBuildState,
  MAX_QUERY_LENGTH,
  rebuildSearchIndex,
  searchProducts,
} from '@muziris/search';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';

export interface SearchRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
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
  app.get('/build', need('product.view'), async (c) =>
    c.json({ build: await getBuildState(deps.db) }),
  );

  /**
   * Rebuilds the whole index and waits for it (ADR 0013). When the job runner lands, this
   * enqueues the build job and answers 202 instead.
   */
  app.post('/build', need('product.manage'), async (c) => {
    const userId = c.get('user').id;
    const result = await rebuildSearchIndex(deps.db, { builtBy: userId });
    deps.logger.info({ requestId: c.get('requestId'), userId, ...result }, 'search.built');
    return c.json({ build: { ...result, builtBy: userId } });
  });

  return app;
}
