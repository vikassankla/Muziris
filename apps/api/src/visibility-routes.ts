import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  createRule,
  deleteRule,
  findRule,
  getBuildState,
  listRules,
  listRulesQuerySchema,
  listVisibleProducts,
  listVisibleProductsQuerySchema,
  newRuleSchema,
  previewVisibility,
  rebuildVisibility,
  ruleChangesSchema,
  updateRule,
  visibilityPreviewQuerySchema,
  VisibilityError,
  type VisibilityErrorCode,
} from '@muziris/visibility';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface VisibilityRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface VisibilityEnv {
  Variables: AdminAccessVariables;
}

const PROBLEMS: Record<VisibilityErrorCode, [ContentfulStatusCode, string]> = {
  rule_not_found: [404, 'No such rule'],
  rule_taken: [409, 'This product or category already has a rule for this target on this website'],
  product_not_found: [404, 'No such product'],
  category_not_found: [404, 'No such category'],
  website_not_found: [404, 'No such website'],
  customer_not_found: [404, 'No such customer'],
  customer_group_not_found: [404, 'No such customer group'],
};

/** Runs a module call, turning refusals into problem responses with the same stable code. */
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof VisibilityError) {
      const [status, title] = PROBLEMS[error.code];
      throw new HttpProblem(status, error.code, title, error.message);
    }
    throw error;
  }
}

const idParam = z.uuid();

/** Query strings carry text only; this turns the page size into a number. */
const limitText = z
  .string()
  .regex(/^\d{1,4}$/, 'Use a whole number')
  .transform(Number)
  .optional();
const queryText = z.string().max(100).optional();

/** Drops keys whose value is undefined, for exactOptionalPropertyTypes. */
function defined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

const listRulesQuery = z
  .object({
    websiteId: queryText,
    subject: queryText,
    subjectId: queryText,
    target: queryText,
    targetId: queryText,
    after: queryText,
    limit: limitText,
  })
  .transform((q) => listRulesQuerySchema.parse(defined(q)));

const visibleProductsQuery = z
  .object({ websiteId: queryText, customerId: queryText, after: queryText, limit: limitText })
  .transform((q) => listVisibleProductsQuerySchema.parse(defined(q)));

const previewQuery = z
  .object({
    websiteId: queryText,
    customerId: queryText,
    productId: queryText,
    categoryId: queryText,
  })
  .transform((q) => visibilityPreviewQuerySchema.parse(defined(q)));

/** Rules, the build, the preview and a customer's visible products, under /admin/v1/visibility. */
export function visibilityRoutes(deps: VisibilityRouteDependencies): Hono<VisibilityEnv> {
  const app = new Hono<VisibilityEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/rules', need('visibility.view'), async (c) =>
    c.json(await listRules(deps.db, listRulesQuery.parse(c.req.query()))),
  );

  app.post('/rules', need('visibility.manage'), async (c) => {
    const input = newRuleSchema.parse(await body(c));
    const rule = await translated(() => createRule(deps.db, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ruleId: rule.id },
      'visibility.rule_created',
    );
    return c.json({ rule }, 201);
  });

  app.get('/rules/:ruleId', need('visibility.view'), async (c) => {
    const ruleId = idParam.parse(c.req.param('ruleId'));
    const rule = await findRule(deps.db, ruleId);
    if (!rule) throw new HttpProblem(404, 'rule_not_found', 'No such rule');
    return c.json({ rule });
  });

  app.patch('/rules/:ruleId', need('visibility.manage'), async (c) => {
    const ruleId = idParam.parse(c.req.param('ruleId'));
    const changes = ruleChangesSchema.parse(await body(c));
    const rule = await translated(() => updateRule(deps.db, ruleId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ruleId },
      'visibility.rule_updated',
    );
    return c.json({ rule });
  });

  app.delete('/rules/:ruleId', need('visibility.manage'), async (c) => {
    const ruleId = idParam.parse(c.req.param('ruleId'));
    await translated(() => deleteRule(deps.db, ruleId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ruleId },
      'visibility.rule_deleted',
    );
    return c.body(null, 204);
  });

  /** Whether rule changes are waiting for a build, and what the last build did. */
  app.get('/build', need('visibility.view'), async (c) =>
    c.json({ build: await getBuildState(deps.db) }),
  );

  /**
   * Runs the set-based visibility build and waits for it (ADR 0012). When the job runner lands,
   * this enqueues the build job and answers 202 instead.
   */
  app.post('/build', need('visibility.manage'), async (c) => {
    const userId = c.get('user').id;
    const result = await rebuildVisibility(deps.db, { builtBy: userId });
    deps.logger.info({ requestId: c.get('requestId'), userId, ...result }, 'visibility.built');
    return c.json({ build: { ...result, builtBy: userId } });
  });

  /** Why a customer can or cannot see a product or a category on a website. */
  app.get('/preview', need('visibility.view'), async (c) => {
    const query = previewQuery.parse(c.req.query());
    const preview = await translated(() => previewVisibility(deps.db, query));
    return c.json({ preview });
  });

  /** The ids of the products a customer sees on a website, from the last build. */
  app.get('/visible-products', need('visibility.view'), async (c) => {
    const query = visibleProductsQuery.parse(c.req.query());
    return c.json(await translated(() => listVisibleProducts(deps.db, query)));
  });

  return app;
}
