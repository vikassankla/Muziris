import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { buyerUsers, customers } from './db/schema.js';

const uuid = z.uuid();

/**
 * Walks down the hierarchy from the ids `start` selects. The CYCLE clause stops the walk if a
 * cycle ever got into the table, so a bad row cannot make the query run forever; the module
 * refuses changes that would create one (setCustomerParent).
 */
function walkDown(start: SQL): SQL {
  return sql`with recursive tree (id) as (
      ${start}
      union all
      select child.id from ${customers} child join tree on child.parent_id = tree.id
    ) cycle id set is_cycle using path
    select id from tree where not is_cycle`;
}

/**
 * An SQL select of the ids of every customer below `customerId`, at any depth, not including
 * it. Pass it to @muziris/access as `descendantCustomerIds`, or use it in `in (...)`: it has no
 * surrounding parentheses.
 */
export function descendantCustomerIds(customerId: string): SQL {
  const id = uuid.parse(customerId);
  return walkDown(sql`select id from ${customers} where parent_id = ${id}`);
}

/** How far a buyer user's reach goes: their own customer, or it and all its subsidiaries. */
export type CustomerReach = 'my_customer' | 'my_customer_and_subsidiaries';

/**
 * An SQL select of the customer ids a buyer user may see at a reach, derived from the buyer
 * user's own customer inside the query. A user id that is not a buyer user selects nothing.
 */
export function reachableCustomerIds(buyerUserId: string, reach: CustomerReach): SQL {
  const own = sql`select customer_id from ${buyerUsers} where user_id = ${uuid.parse(buyerUserId)}`;
  switch (reach) {
    case 'my_customer':
      return own;
    case 'my_customer_and_subsidiaries':
      return walkDown(own);
  }
}
