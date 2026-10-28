import type { AdminPermission } from '@muziris/access';
import {
  buildCategoryTree,
  CatalogError,
  createCategory,
  createProduct,
  createProductUnit,
  deleteCategory,
  findProduct,
  categoryChangesSchema,
  listCategories,
  listProducts,
  listProductUnits,
  listProductsQuerySchema,
  newCategorySchema,
  newProductSchema,
  newProductUnitSchema,
  productChangesSchema,
  productUnitsSchema,
  setCategoryParent,
  setProductUnits,
  updateCategory,
  updateProduct,
  type CatalogErrorCode,
} from '@muziris/catalog';
import type { Database } from '@muziris/db';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface CatalogRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface CatalogEnv {
  Variables: AdminAccessVariables;
}

const PROBLEMS: Record<CatalogErrorCode, [ContentfulStatusCode, string]> = {
  product_not_found: [404, 'No such product'],
  sku_taken: [409, 'Another product already uses this SKU'],
  product_unit_not_found: [404, 'No such product unit'],
  product_unit_code_taken: [409, 'A product unit with this code already exists'],
  category_not_found: [404, 'No such category'],
  category_code_taken: [409, 'A category with this code already exists'],
  category_cycle: [409, 'A category cannot be moved under itself or its subcategories'],
  category_not_empty: [409, 'The category still has subcategories or products'],
};

/** Runs a module call, turning refusals into problem responses with the same stable code. */
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CatalogError) {
      const [status, title] = PROBLEMS[error.code];
      throw new HttpProblem(status, error.code, title);
    }
    throw error;
  }
}

const idParam = z.uuid();

/** Query strings carry text only; turn them into the module's query shape. */
const listProductsQuery = z
  .object({
    categoryId: z.string().max(64).optional(),
    includeSubcategories: z.enum(['true', 'false']).optional(),
    status: z.string().max(20).optional(),
    after: z.string().max(100).optional(),
    limit: z
      .string()
      .regex(/^\d{1,4}$/, 'Use a whole number')
      .optional(),
  })
  .transform(({ includeSubcategories, limit, ...rest }) =>
    listProductsQuerySchema.parse({
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(includeSubcategories === undefined
        ? {}
        : { includeSubcategories: includeSubcategories === 'true' }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    }),
  );

const setParentBody = z.object({ parentId: z.uuid().nullable() });

/** Products, product units and categories, mounted under /admin/v1/catalog. */
export function catalogRoutes(deps: CatalogRouteDependencies): Hono<CatalogEnv> {
  const app = new Hono<CatalogEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/product-units', need('product.view'), async (c) =>
    c.json({ productUnits: await listProductUnits(deps.db) }),
  );

  app.post('/product-units', need('product.manage'), async (c) => {
    const input = newProductUnitSchema.parse(await body(c));
    const productUnit = await translated(() => createProductUnit(deps.db, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, productUnit: productUnit.code },
      'catalog.product_unit_created',
    );
    return c.json({ productUnit }, 201);
  });

  /** The whole category tree, siblings in display order. */
  app.get('/categories', need('product.view'), async (c) =>
    c.json({ categories: buildCategoryTree(await listCategories(deps.db)) }),
  );

  app.post('/categories', need('product.manage'), async (c) => {
    const input = newCategorySchema.parse(await body(c));
    const category = await translated(() => createCategory(deps.db, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, categoryId: category.id },
      'catalog.category_created',
    );
    return c.json({ category }, 201);
  });

  app.patch('/categories/:categoryId', need('product.manage'), async (c) => {
    const categoryId = idParam.parse(c.req.param('categoryId'));
    const changes = categoryChangesSchema.parse(await body(c));
    const category = await translated(() => updateCategory(deps.db, categoryId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, categoryId },
      'catalog.category_updated',
    );
    return c.json({ category });
  });

  app.put('/categories/:categoryId/parent', need('product.manage'), async (c) => {
    const categoryId = idParam.parse(c.req.param('categoryId'));
    const { parentId } = setParentBody.parse(await body(c));
    const category = await translated(() => setCategoryParent(deps.db, categoryId, parentId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, categoryId, parentId },
      'catalog.category_moved',
    );
    return c.json({ category });
  });

  app.delete('/categories/:categoryId', need('product.manage'), async (c) => {
    const categoryId = idParam.parse(c.req.param('categoryId'));
    await translated(() => deleteCategory(deps.db, categoryId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, categoryId },
      'catalog.category_deleted',
    );
    return c.body(null, 204);
  });

  app.get('/products', need('product.view'), async (c) =>
    c.json(await listProducts(deps.db, listProductsQuery.parse(c.req.query()))),
  );

  app.post('/products', need('product.manage'), async (c) => {
    const input = newProductSchema.parse(await body(c));
    const product = await translated(() => createProduct(deps.db, input));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, productId: product.id },
      'catalog.product_created',
    );
    return c.json({ product }, 201);
  });

  app.get('/products/:productId', need('product.view'), async (c) => {
    const productId = idParam.parse(c.req.param('productId'));
    const product = await findProduct(deps.db, productId);
    if (!product) throw new HttpProblem(404, 'product_not_found', 'No such product');
    return c.json({ product });
  });

  app.patch('/products/:productId', need('product.manage'), async (c) => {
    const productId = idParam.parse(c.req.param('productId'));
    const changes = productChangesSchema.parse(await body(c));
    const product = await translated(() => updateProduct(deps.db, productId, changes));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, productId },
      'catalog.product_updated',
    );
    return c.json({ product });
  });

  app.put('/products/:productId/units', need('product.manage'), async (c) => {
    const productId = idParam.parse(c.req.param('productId'));
    const units = productUnitsSchema.parse(await body(c));
    const product = await translated(() => setProductUnits(deps.db, productId, units));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, productId },
      'catalog.product_units_set',
    );
    return c.json({ product });
  });

  return app;
}
