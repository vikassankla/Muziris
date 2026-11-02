import type { AdminPermission } from '@muziris/access';
import { findProductBySku, findProductsByIds } from '@muziris/catalog';
import { toCsv } from '@muziris/csv';
import { customerGroupNames, customerNames } from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  compareDecimals,
  decimalToString,
  parseDecimal,
  toDecimalString,
  type Money,
} from '@muziris/money';
import { findOrganization, listWebsites } from '@muziris/platform';
import {
  addPrice,
  allPrices,
  assignmentChangesSchema,
  createAssignment,
  createPriceList,
  deleteAssignment,
  deletePrice,
  deletePriceList,
  findPriceList,
  getBuildState,
  importPrices,
  listAssignments,
  listAssignmentsQuerySchema,
  listPriceLists,
  listPriceListsQuerySchema,
  listPrices,
  listPricesQuerySchema,
  newAssignmentSchema,
  newPriceListSchema,
  newPriceSchema,
  PRICE_CSV_COLUMNS,
  PriceImportError,
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
  type Assignment,
  type ChainStep,
  type Price,
  type PricePreview,
  type PricingErrorCode,
} from '@muziris/pricing';
import { searchProductIds } from '@muziris/search';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem, problemResponse, toProblem } from './problem.js';

/** A price import's CSV may be up to 2 MB (ADR 0022); every other body has the global limit. */
export const PRICE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const LARGE_BODY_PATH = /^\/admin\/v1\/pricing\/price-lists\/[^/]+\/prices\/import$/;

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

const listPricesQuery = z.object({
  /** An SKU, or words of a product name: the prices of the products that match. */
  q: z.string().trim().min(1).max(100).optional(),
  productId: queryText,
  unitCode: queryText,
  after: queryText,
  limit: limitText,
});

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

/** SKU and name by product id, from catalog's public interface, at most 1,000 ids a call. */
async function productNames(
  db: Database,
  productIds: readonly string[],
): Promise<Map<string, { sku: string; name: string }>> {
  const ids = [...new Set(productIds)];
  const names = new Map<string, { sku: string; name: string }>();
  for (let start = 0; start < ids.length; start += 1000) {
    for (const p of await findProductsByIds(db, ids.slice(start, start + 1000))) {
      names.set(p.id, { sku: p.sku, name: p.name });
    }
  }
  return names;
}

function priceJson(price: Price, product?: { sku: string; name: string }) {
  return {
    id: price.id,
    priceListId: price.priceListId,
    productId: price.productId,
    sku: product?.sku ?? null,
    productName: product?.name ?? null,
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
    const { q, ...rest } = listPricesQuery.parse(c.req.query());
    const query = listPricesQuerySchema.parse(defined(rest));
    if (q !== undefined) {
      // An exact SKU first, as the search index may not have a new product yet.
      const exact = await findProductBySku(deps.db, q);
      const found = await searchProductIds(deps.db, q);
      query.productIds = [...new Set([...(exact ? [exact.id] : []), ...found])].slice(0, 1000);
    }
    const page = await translated(() => listPrices(deps.db, priceListId, query));
    const names = await productNames(
      deps.db,
      page.prices.map((p) => p.productId),
    );
    return c.json({
      prices: page.prices.map((p) => priceJson(p, names.get(p.productId))),
      nextAfter: page.nextAfter,
    });
  });

  app.post('/price-lists/:priceListId/prices', need('price_list.manage'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    const input = newPriceSchema.parse(await body(c));
    const price = await translated(() => addPrice(deps.db, priceListId, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceListId, priceId: price.id },
      'pricing.price_added',
    );
    return c.json(
      {
        price: priceJson(
          price,
          (await productNames(deps.db, [price.productId])).get(price.productId),
        ),
      },
      201,
    );
  });

  app.patch('/prices/:priceId', need('price_list.manage'), async (c) => {
    const priceId = idParam.parse(c.req.param('priceId'));
    const changes = priceChangesSchema.parse(await body(c));
    const price = await translated(() => updatePrice(deps.db, priceId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, priceId },
      'pricing.price_updated',
    );
    return c.json({
      price: priceJson(
        price,
        (await productNames(deps.db, [price.productId])).get(price.productId),
      ),
    });
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

  /** Assignments with the names of their targets and websites beside the ids. */
  async function withNames(list: readonly Assignment[]) {
    const ofTarget = (target: Assignment['target']) =>
      list.filter((a) => a.target === target).map((a) => a.targetId);
    const organization = await findOrganization(deps.db);
    const [customers, groups, websites] = await Promise.all([
      customerNames(deps.db, ofTarget('customer')),
      customerGroupNames(deps.db, ofTarget('customer_group')),
      organization ? listWebsites(deps.db, organization.id) : Promise.resolve([]),
    ]);
    const websiteNames = new Map(websites.map((w) => [w.id, w.name]));
    return list.map((a) => ({
      ...a,
      websiteName: websiteNames.get(a.websiteId) ?? null,
      targetName:
        (a.target === 'customer'
          ? customers.get(a.targetId)
          : a.target === 'customer_group'
            ? groups.get(a.targetId)
            : websiteNames.get(a.targetId)) ?? null,
    }));
  }

  /**
   * Imports prices from CSV (text/csv, at most 2 MB): every row, or with skipInvalid=true the
   * valid ones. Refused rows come back by row number with a stable code.
   */
  app.post(
    '/price-lists/:priceListId/prices/import',
    need('price_list.manage'),
    bodyLimit({
      maxSize: PRICE_IMPORT_MAX_BYTES,
      onError: () => {
        throw new HttpProblem(413, 'payload_too_large', 'The file is larger than 2 MB');
      },
    }),
    async (c) => {
      const priceListId = idParam.parse(c.req.param('priceListId'));
      if (!(c.req.header('content-type') ?? '').startsWith('text/csv')) {
        throw new HttpProblem(415, 'unsupported_media_type', 'Send the prices as text/csv');
      }
      const skipInvalid = c.req.query('skipInvalid') === 'true';
      const csv = await c.req.text();
      try {
        const result = await translated(() =>
          importPrices(deps.db, priceListId, csv, { skipInvalid }),
        );
        deps.logger.info(
          {
            requestId: c.get('requestId'),
            userId: c.get('user').id,
            priceListId,
            added: result.added,
            updated: result.updated,
            skipped: result.skipped.length,
          },
          'pricing.prices_imported',
        );
        return c.json(result);
      } catch (error) {
        if (!(error instanceof PriceImportError)) throw error;
        const problem = {
          ...toProblem(
            c,
            new HttpProblem(
              422,
              error.code === 'invalid_rows'
                ? 'price_import_invalid_rows'
                : 'price_import_invalid_file',
              error.code === 'invalid_rows'
                ? 'Some rows are not valid prices; nothing was imported'
                : 'The file is not a price CSV',
              error.message,
            ),
          ),
          rows: error.rows,
        };
        return problemResponse(c, problem);
      }
    },
  );

  /** Every price of a list as CSV, by SKU, unit and minimum quantity, ready to import again. */
  app.get('/price-lists/:priceListId/prices.csv', need('price_list.view'), async (c) => {
    const priceListId = idParam.parse(c.req.param('priceListId'));
    const all = await translated(() => allPrices(deps.db, priceListId));
    const names = await productNames(
      deps.db,
      all.map((p) => p.productId),
    );
    const rows = all
      .flatMap((p) => {
        const sku = names.get(p.productId)?.sku;
        return sku === undefined ? [] : [{ sku, price: p }];
      })
      .sort(
        (a, b) =>
          a.sku.localeCompare(b.sku, 'en', { sensitivity: 'base' }) ||
          a.price.unitCode.localeCompare(b.price.unitCode) ||
          compareDecimals(parseDecimal(a.price.minQuantity), parseDecimal(b.price.minQuantity)),
      )
      .map(({ sku, price }) => [sku, price.unitCode, price.minQuantity, amountJson(price.amount)]);
    return c.body(toCsv(PRICE_CSV_COLUMNS, rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="prices.csv"',
    });
  });

  app.get('/assignments', need('price_list.view'), async (c) => {
    const page = await listAssignments(deps.db, listAssignmentsQuery.parse(c.req.query()));
    return c.json({ ...page, assignments: await withNames(page.assignments) });
  });

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
