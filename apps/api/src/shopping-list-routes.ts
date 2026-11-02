import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  findShoppingListById,
  listShoppingListsForCustomer,
  type ShoppingList,
  type ShoppingListSummary,
} from '@muziris/shopping-lists';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

// Buyers' shopping lists under /admin/v1/shopping-lists (ADR 0018), read only, for support
// staff with customer.view. Buyers change their lists in the storefront.

export interface ShoppingListRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface ShoppingListEnv {
  Variables: AdminAccessVariables;
}

const listQuery = z.object({
  customerId: z.uuid(),
  after: z.string().max(200).optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/, 'Use a whole number')
    .transform(Number)
    .pipe(z.int().min(1).max(200))
    .optional(),
});

function summaryJson(list: ShoppingListSummary) {
  return {
    id: list.id,
    websiteId: list.websiteId,
    customerId: list.customerId,
    ownerId: list.ownerId,
    name: list.name,
    lineCount: list.lineCount,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  };
}

function listJson(list: ShoppingList) {
  return { ...summaryJson(list), lines: list.lines };
}

/** Shopping lists, under /admin/v1/shopping-lists. */
export function shoppingListRoutes(deps: ShoppingListRouteDependencies): Hono<ShoppingListEnv> {
  const app = new Hono<ShoppingListEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/', need('customer.view'), async (c) => {
    const q = listQuery.parse(c.req.query());
    const page = await listShoppingListsForCustomer(deps.db, q.customerId, {
      ...(q.after === undefined ? {} : { after: q.after }),
      ...(q.limit === undefined ? {} : { limit: q.limit }),
    });
    return c.json({ shoppingLists: page.lists.map(summaryJson), nextAfter: page.nextAfter });
  });

  app.get('/:listId', need('customer.view'), async (c) => {
    const list = await findShoppingListById(deps.db, c.req.param('listId'));
    if (!list) throw new HttpProblem(404, 'shopping_list_not_found', 'No such shopping list');
    return c.json({ shoppingList: listJson(list) });
  });

  return app;
}
