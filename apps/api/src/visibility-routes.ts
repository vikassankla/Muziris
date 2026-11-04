import type { AdminPermission } from '@muziris/access';
import { findProductBySku, findProductsByIds, listCategories } from '@muziris/catalog';
import {
  customerGroupIdsMatching,
  customerGroupNames,
  customerIdsMatching,
  customerNames,
} from '@muziris/customers';
import type { Database } from '@muziris/db';
import { findOrganization, listWebsites } from '@muziris/platform';
import { searchProductIds } from '@muziris/search';
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
  ruleChangesSchema,
  updateRule,
  visibilityPreviewQuerySchema,
  VisibilityError,
  type Rule,
  type VisibilityErrorCode,
} from '@muziris/visibility';
import type { JobQueue } from '@muziris/jobs';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import { writeAndBuild } from './jobs.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface VisibilityRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Rule writes enqueue the visibility build in their transaction (ADR 0025). */
  jobs: JobQueue;
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

const BUILD = ['visibility.build'] as const;

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
    q: z.string().trim().min(1).max(100).optional(),
    websiteId: queryText,
    subject: queryText,
    subjectId: queryText,
    target: queryText,
    targetId: queryText,
    after: queryText,
    limit: limitText,
  })
  .transform(({ q, ...rest }) => ({ q, query: listRulesQuerySchema.parse(defined(rest)) }));

/** A category's names from the top of the tree down to it: "Power transmission / Bearings". */
function categoryPaths(
  categories: readonly { id: string; name: string; parentId: string | null }[],
): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const paths = new Map<string, string>();
  for (const category of categories) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (
      let at: typeof category | undefined = category;
      at && !seen.has(at.id);
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    ) {
      seen.add(at.id);
      names.unshift(at.name);
    }
    paths.set(category.id, names.join(' / '));
  }
  return paths;
}

/**
 * Rules with the names of their subjects and targets beside the ids (ADR 0027), from the
 * modules that own them. A subject or target that no longer exists has a null name.
 */
async function withNames(db: Database, list: readonly Rule[]) {
  const ids = (pick: (r: Rule) => string, keep: (r: Rule) => boolean) =>
    [...new Set(list.filter(keep).map(pick))].slice(0, 1000);
  const organization = await findOrganization(db);
  const [products, categories, customers, groups, websites] = await Promise.all([
    findProductsByIds(
      db,
      ids(
        (r) => r.subjectId,
        (r) => r.subject === 'product',
      ),
    ),
    list.some((r) => r.subject === 'category') ? listCategories(db) : Promise.resolve([]),
    customerNames(
      db,
      ids(
        (r) => r.targetId,
        (r) => r.target === 'customer',
      ),
    ),
    customerGroupNames(
      db,
      ids(
        (r) => r.targetId,
        (r) => r.target === 'customer_group',
      ),
    ),
    organization ? listWebsites(db, organization.id) : Promise.resolve([]),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const paths = categoryPaths(categories);
  const websiteNames = new Map(websites.map((w) => [w.id, w.name]));
  return list.map((rule) => {
    const product = rule.subject === 'product' ? productById.get(rule.subjectId) : undefined;
    return {
      ...rule,
      subjectSku: product?.sku ?? null,
      subjectName: (rule.subject === 'product' ? product?.name : paths.get(rule.subjectId)) ?? null,
      targetName:
        (rule.target === 'customer'
          ? customers.get(rule.targetId)
          : rule.target === 'customer_group'
            ? groups.get(rule.targetId)
            : websiteNames.get(rule.targetId)) ?? null,
    };
  });
}

/**
 * The ids a rule search matches (ADR 0027): products by exact SKU or the admin search,
 * categories, customers and customer groups by name, each from the module that owns them.
 */
async function idsMatching(db: Database, text: string): Promise<string[]> {
  const lower = text.toLowerCase();
  const [exact, products, categories, customers, groups] = await Promise.all([
    findProductBySku(db, text),
    searchProductIds(db, text),
    listCategories(db),
    customerIdsMatching(db, text),
    customerGroupIdsMatching(db, text),
  ]);
  return [
    ...(exact ? [exact.id] : []),
    ...products,
    ...categories.filter((c) => c.name.toLowerCase().includes(lower)).map((c) => c.id),
    ...customers,
    ...groups,
  ];
}

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

  app.get('/rules', need('visibility.view'), async (c) => {
    const { q, query } = listRulesQuery.parse(c.req.query());
    const page = await listRules(
      deps.db,
      query,
      q === undefined ? {} : { matchingIds: await idsMatching(deps.db, q) },
    );
    return c.json({ rules: await withNames(deps.db, page.rules), nextAfter: page.nextAfter });
  });

  app.post('/rules', need('visibility.manage'), async (c) => {
    const input = newRuleSchema.parse(await body(c));
    const rule = await translated(() => writeAndBuild(deps, BUILD, (db) => createRule(db, input)));
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
    const [named] = await withNames(deps.db, [rule]);
    return c.json({ rule: named });
  });

  app.patch('/rules/:ruleId', need('visibility.manage'), async (c) => {
    const ruleId = idParam.parse(c.req.param('ruleId'));
    const changes = ruleChangesSchema.parse(await body(c));
    const rule = await translated(() =>
      writeAndBuild(deps, BUILD, (db) => updateRule(db, ruleId, changes)),
    );
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ruleId },
      'visibility.rule_updated',
    );
    return c.json({ rule });
  });

  app.delete('/rules/:ruleId', need('visibility.manage'), async (c) => {
    const ruleId = idParam.parse(c.req.param('ruleId'));
    await translated(() => writeAndBuild(deps, BUILD, (db) => deleteRule(db, ruleId)));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ruleId },
      'visibility.rule_deleted',
    );
    return c.body(null, 204);
  });

  /**
   * Whether rule or catalog changes are waiting for a build, what the last build did, and
   * whether a build is queued or running.
   */
  app.get('/build', need('visibility.view'), async (c) => {
    const [state, job] = await Promise.all([
      getBuildState(deps.db),
      deps.jobs.status('visibility.build'),
    ]);
    return c.json({ build: { ...state, job } });
  });

  /** Queues the visibility build now (ADR 0025); the worker runs it within seconds. */
  app.post('/build', need('visibility.manage'), async (c) => {
    await deps.jobs.enqueue('visibility.build');
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id },
      'visibility.build_queued',
    );
    return c.json({ build: { job: await deps.jobs.status('visibility.build') } }, 202);
  });

  /** Why a customer can or cannot see a product or a category on a website. */
  app.get('/preview', need('visibility.view'), async (c) => {
    const query = previewQuery.parse(c.req.query());
    const preview = await translated(() => previewVisibility(deps.db, query));
    const [rule] = preview.rule ? await withNames(deps.db, [preview.rule]) : [null];
    return c.json({ preview: { ...preview, rule } });
  });

  /** The ids of the products a customer sees on a website, from the last build. */
  app.get('/visible-products', need('visibility.view'), async (c) => {
    const query = visibleProductsQuery.parse(c.req.query());
    return c.json(await translated(() => listVisibleProducts(deps.db, query)));
  });

  return app;
}
