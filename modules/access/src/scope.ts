import { and, eq, inArray, or, sql, type Column, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { BuyerAccess } from './buyer-roles.js';
import type { AccessLevel, BuyerPermission } from './permissions.js';

/**
 * Who is asking, for scoping a storefront query. Built per request from the signed-in buyer
 * user and the customer they act for.
 *
 * The customer hierarchy belongs to the customers module, which will export a function that
 * returns `descendantCustomerIds` as a subquery (for example a recursive CTE over its own
 * table), so this module never reads customer tables. Until then, or where the ids are already
 * known, pass them as a list.
 */
export interface BuyerScopeContext {
  buyerUserId: string;
  customerId: string;
  /**
   * Customers below `customerId` in the hierarchy, at any depth, not including it. Either a
   * list of ids, or an `SQL` select of a single uuid column: a `sql` fragment or a query
   * builder's `.getSQL()`, without surrounding parentheses. Only read for "my customer and
   * subsidiaries".
   */
  descendantCustomerIds: readonly string[] | SQL;
}

/** The columns of the table being queried that say who owns a record and for which customer. */
export interface BuyerScopeColumns {
  ownerBuyerUserId: Column;
  customerId: Column;
}

const uuid = z.uuid();

/** Matches no rows. Used whenever access is missing, so mistakes fail closed. */
const NOTHING = sql`false`;

function isIdList(ids: BuyerScopeContext['descendantCustomerIds']): ids is readonly string[] {
  return Array.isArray(ids);
}

/**
 * A WHERE predicate limiting rows to what a buyer may reach at an access level:
 *
 * - own records: rows they own at their current customer
 * - my customer: every row of their customer
 * - my customer and subsidiaries: every row of their customer and its descendants
 *
 * No access level means no rows. Every value is bound as a parameter.
 */
export function buyerScopePredicate(
  level: AccessLevel | undefined,
  context: BuyerScopeContext,
  columns: BuyerScopeColumns,
): SQL {
  if (level === undefined) return NOTHING;
  const customerId = uuid.parse(context.customerId);
  const ownCustomer = eq(columns.customerId, customerId);
  switch (level) {
    case 'own_records':
      return (
        and(ownCustomer, eq(columns.ownerBuyerUserId, uuid.parse(context.buyerUserId))) ?? NOTHING
      );
    case 'my_customer':
      return ownCustomer;
    case 'my_customer_and_subsidiaries': {
      const below = context.descendantCustomerIds;
      // inArray would not parenthesise a raw SQL subquery, so wrap it here.
      if (!isIdList(below))
        return or(ownCustomer, sql`${columns.customerId} in (${below})`) ?? NOTHING;
      if (below.length === 0) return ownCustomer;
      const ids = below.map((id) => uuid.parse(id));
      return or(ownCustomer, inArray(columns.customerId, ids)) ?? NOTHING;
    }
  }
}

/**
 * Scopes a query to what a buyer may reach with one permission. Use it in the query itself:
 *
 *   db.select().from(orders).where(and(eq(orders.status, 'open'),
 *     buyerScope(access, 'order.view', context, { ownerBuyerUserId: orders.placedBy,
 *       customerId: orders.customerId })))
 */
export function buyerScope(
  access: BuyerAccess,
  permission: BuyerPermission,
  context: BuyerScopeContext,
  columns: BuyerScopeColumns,
): SQL {
  return buyerScopePredicate(access.get(permission), context, columns);
}
