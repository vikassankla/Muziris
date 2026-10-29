import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import { decimalToString, toDecimalString, type Money } from '@muziris/money';
import {
  addPrice,
  assignmentChangesSchema,
  createAssignment,
  createPriceList,
  deleteAssignment,
  deletePrice,
  deletePriceList,
  findPriceList,
  getBuildState,
  listAssignments,
  listAssignmentsQuerySchema,
  listPriceLists,
  listPriceListsQuerySchema,
  listPrices,
  listPricesQuerySchema,
  newAssignmentSchema,
  newPriceListSchema,
  newPriceSchema,
  previewPrice,
  priceChangesSchema,
  pricePreviewQuerySchema,
  priceListChangesSchema,
  priceListStatus,
  PricingError,
  rebuildCombinedPrices,
  updateAssignment,
  updatePrice,
  updatePriceList,
  type ChainStep,
  type Price,
  type PricePreview,
  type PricingErrorCode,
} from '@muziris/pricing';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface PricingRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface PricingEnv {
  Variables: AdminAccessVariables;
}

const PROBLEMS: Record<PricingErrorCode, [ContentfulStatusCode, string]> = {
  price_list_not_found: [404, 'No such price list'],
  active_dates_out_of_order: [400, 'A price list must end after it starts'],
  price_not_found: [404, 'No such price'],
  price_tier_taken: [
    409,
    'The price list already has a price for this product, product unit and minimum quantity',
  ],
  invalid_amount: [400, 'The amount is not valid in the price list currency'],
  invalid_quantity: [400, 'The quantity is not valid in this product unit'],
  product_not_found: [404, 'No such product'],
  product_unit_not_sold: [422, 'The product is not sold in this product unit'],
  assignment_not_found: [404, 'No such assignment'],
  assignment_taken: [409, 'The price list is already assigned to this target on this website'],
  assignment_priority_taken: [
    409,
    'Another price list has this priority for this target on this website',
  ],
  currency_mismatch: [422, 'The price list currency is not the website currency'],
  website_not_found: [404, 'No such website'],
  customer_not_found: [404, 'No such customer'],
  customer_group_not_found: [404, 'No such customer group'],
};

/** Runs a module call, turning refusals into problem responses with the same stable code. */
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PricingError) {
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

const listPriceListsQuery = z
  .object({ currency: queryText, after: queryText, limit: limitText })
  .transform((q) => listPriceListsQuerySchema.parse(defined(q)));

const listPricesQuery = z
  .object({ productId: queryText, unitCode: queryText, after: queryText, limit: limitText })
  .transform((q) => listPricesQuerySchema.parse(defined(q)));

const listAssignmentsQuery = z
  .object({
    priceListId: queryText,
    websiteId: queryText,
    target: queryText,
    targetId: queryText,
    after: queryText,
    limit: limitText,
  })
  .transform((q) => listAssignmentsQuerySchema.parse(defined(q)));

const previewQuery = z
  .object({
    customerId: queryText,
    websiteId: queryText,
    productId: queryText,
    unitCode: queryText,
    quantity: queryText,
  })
  .transform((q) => pricePreviewQuerySchema.parse(defined(q)));

// Amounts leave the API as decimal strings in major units, never as JSON numbers (ADR 0004).

function amountJson(amount: Money): string {
  return toDecimalString(amount);
}

function priceJson(price: Price) {
  return {
    id: price.id,
    priceListId: price.priceListId,
    productId: price.productId,
    unitCode: price.unitCode,
    minQuantity: price.minQuantity,
    amount: amountJson(price.amount),
    currency: price.amount.currency,
    createdAt: price.createdAt,
    updatedAt: price.updatedAt,
  };
}

function stepJson(step: ChainStep) {
  return {
    target: step.entry.target,
    targetId: step.entry.targetId,
    priority: step.entry.priority,
    priceListId: step.entry.priceList.id,
    priceListName: step.entry.priceList.name,
    status: step.status,
    tier:
      step.tier === null
        ? null
        : {
            minQuantity: decimalToString(step.tier.minQuantity),
            unitPrice: amountJson(step.tier.amount),
          },
  };
}

function previewJson(preview: PricePreview) {
  return {
    currency: preview.currency,
    quantity: decimalToString(preview.quantity),
    price:
      preview.price === null
        ? null
        : {
            unitPrice: amountJson(preview.price.unitPrice),
            minQuantity: preview.price.minQuantity,
            priceListId: preview.price.priceListId,
          },
    lineAmount: preview.lineAmount === null ? null : amountJson(preview.lineAmount),
    reason: preview.reason,
    steps: preview.steps.map(stepJson),
    unbuiltPrice:
      preview.unbuiltPrice === null
        ? null
        : {
            unitPrice: amountJson(preview.unbuiltPrice.unitPrice),
            minQuantity: decimalToString(preview.unbuiltPrice.minQuantity),
            priceListId: preview.unbuiltPrice.priceListId,
          },
    pendingChanges: preview.pendingChanges,
  };
}

/** Price lists, prices, assignments, the build and the preview, under /admin/v1/pricing. */
export function pricingRoutes(deps: PricingRouteDependencies): Hono<PricingEnv> {
  const app = new Hono<PricingEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/price-lists', need('price_list.view'), async (c) =>
    c.json(await listPriceLists(deps.db, listPriceListsQuery.parse(c.req.query()), deps.now())),
  );

  app.post('/price-lists', need('price_list.manage'), async (c) => {
    const input = newPriceListSchema.parse(await body(c));
    const priceList = await translated(() => createPriceList(deps.db, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceListId: priceList.id },
      'pricing.price_list_created',
    );
    return c.json(
      { priceList: { ...priceList, status: priceListStatus(priceList, deps.now()) } },
      201,
    );
  });

  app.get('/price-lists/:priceListId', need('price_list.view'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    const priceList = await findPriceList(deps.db, priceListId);
    if (!priceList) throw new HttpProblem(404, 'price_list_not_found', 'No such price list');
    return c.json({ priceList: { ...priceList, status: priceListStatus(priceList, deps.now()) } });
  });

  app.patch('/price-lists/:priceListId', need('price_list.manage'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    const changes = priceListChangesSchema.parse(await body(c));
    const priceList = await translated(() => updatePriceList(deps.db, priceListId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceListId },
      'pricing.price_list_updated',
    );
    return c.json({ priceList: { ...priceList, status: priceListStatus(priceList, deps.now()) } });
  });

  app.delete('/price-lists/:priceListId', need('price_list.manage'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    await translated(() => deletePriceList(deps.db, priceListId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceListId },
      'pricing.price_list_deleted',
    );
    return c.body(null, 204);
  });

  app.get('/price-lists/:priceListId/prices', need('price_list.view'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    const query = listPricesQuery.parse(c.req.query());
    const page = await translated(() => listPrices(deps.db, priceListId, query));
    return c.json({ prices: page.prices.map(priceJson), nextAfter: page.nextAfter });
  });

  app.post('/price-lists/:priceListId/prices', need('price_list.manage'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    const input = newPriceSchema.parse(await body(c));
    const price = await translated(() => addPrice(deps.db, priceListId, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceListId, priceId: price.id },
      'pricing.price_added',
    );
    return c.json({ price: priceJson(price) }, 201);
  });

  app.patch('/prices/:priceId', need('price_list.manage'), async (c) => {
    const priceId = idParam.parse(c.req.param('priceId'));
    const changes = priceChangesSchema.parse(await body(c));
    const price = await translated(() => updatePrice(deps.db, priceId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceId },
      'pricing.price_updated',
    );
    return c.json({ price: priceJson(price) });
  });

  app.delete('/prices/:priceId', need('price_list.manage'), async (c) => {
    const priceId = idParam.parse(c.req.param('priceId'));
    await translated(() => deletePrice(deps.db, priceId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceId },
      'pricing.price_deleted',
    );
    return c.body(null, 204);
  });

  app.get('/assignments', need('price_list.view'), async (c) =>
    c.json(await listAssignments(deps.db, listAssignmentsQuery.parse(c.req.query()))),
  );

  app.post('/assignments', need('price_list.manage'), async (c) => {
    const input = newAssignmentSchema.parse(await body(c));
    const assignment = await translated(() => createAssignment(deps.db, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, assignmentId: assignment.id },
      'pricing.assignment_created',
    );
    return c.json({ assignment }, 201);
  });

  app.patch('/assignments/:assignmentId', need('price_list.manage'), async (c) => {
    const assignmentId = idParam.parse(c.req.param('assignmentId'));
    const changes = assignmentChangesSchema.parse(await body(c));
    const assignment = await translated(() => updateAssignment(deps.db, assignmentId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, assignmentId },
      'pricing.assignment_updated',
    );
    return c.json({ assignment });
  });

  app.delete('/assignments/:assignmentId', need('price_list.manage'), async (c) => {
    const assignmentId = idParam.parse(c.req.param('assignmentId'));
    await translated(() => deleteAssignment(deps.db, assignmentId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, assignmentId },
      'pricing.assignment_deleted',
    );
    return c.body(null, 204);
  });

  /** Whether changes are waiting for a build, and what the last build did. */
  app.get('/build', need('price_list.view'), async (c) =>
    c.json({ build: await getBuildState(deps.db) }),
  );

  /**
   * Runs the set-based combined price build and waits for it (ADR 0011). When the job runner
   * lands, this enqueues the build job and answers 202 instead.
   */
  app.post('/build', need('price_list.manage'), async (c) => {
    const userId = c.get('user').id;
    const result = await rebuildCombinedPrices(deps.db, { builtBy: userId });
    deps.logger.info(
      { requestId: c.get('requestId'), userId, ...result },
      'pricing.combined_prices_built',
    );
    return c.json({ build: { ...result, builtBy: userId } });
  });

  /** The price a customer gets for a quantity of a product on a website, explained. */
  app.get('/preview', need('price_list.view'), async (c) => {
    const query = previewQuery.parse(c.req.query());
    const preview = await translated(() => previewPrice(deps.db, query, deps.now()));
    return c.json({ preview: previewJson(preview) });
  });

  return app;
}
