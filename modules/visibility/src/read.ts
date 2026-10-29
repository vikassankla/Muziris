import { productCategoryAndStatus } from '@muziris/catalog';
import { customerGroupMembership, findCustomer, reachableCustomerIds } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { findWebsite } from '@muziris/platform';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { contexts, visibleCategories, visibleProducts } from './db/schema.js';
import { VisibilityError } from './errors.js';
import { pageQuerySchema, toPage } from './page.js';

// Reads of the build's result (ADR 0012). They never walk rules or the category tree. Each
// returns an SQL select for search and the storefront to put inside their own queries, so the
// buyer's scope is part of the query that lists products, not a filter applied afterwards.

const uuid = z.uuid();

/**
 * An SQL select of the one context that serves a customer on a website: the customer's own, if
 * it was built with the customer's current group; otherwise the group's on the website; then the
 * website's; then the default. A customer with its own context whose group has changed since the
 * build gets none, so it sees nothing until the next build. `customer` selects at most one
 * customer id as `customer_id`; an unknown customer selects no context.
 */
function servingContextId(customer: SQL, websiteId: string): SQL {
  return sql`with who as (select customer_id from (${customer}) c limit 1),
    grp as (
      select m.group_id from (${customerGroupMembership()}) m
      join who on who.customer_id = m.customer_id
    ),
    own as (
      select id, customer_group_id from ${contexts}
      where website_id = ${websiteId} and target = 'customer'
        and target_id = (select customer_id from who)
    )
    select case when exists (select 1 from own) then
      (select id from own
        where customer_group_id is not distinct from (select group_id from grp))
    else coalesce(
      (select id from ${contexts}
        where website_id = ${websiteId} and target = 'customer_group'
          and target_id = (select group_id from grp)),
      (select id from ${contexts}
        where website_id = ${websiteId} and target = 'website' and target_id = ${websiteId}),
      (select id from ${contexts} where target = 'default')
    ) end as context_id
    where exists (select 1 from grp)`;
}

function productIdsIn(context: SQL): SQL {
  return sql`select v.product_id from ${visibleProducts} v
    join (${productCategoryAndStatus()}) p on p.product_id = v.product_id
    where p.status = 'enabled' and v.context_id = (${context})`;
}

function categoryIdsIn(context: SQL): SQL {
  return sql`select v.category_id from ${visibleCategories} v
    where v.context_id = (${context})`;
}

function buyersCustomer(buyerUserId: string): SQL {
  const own = reachableCustomerIds(buyerUserId, 'my_customer');
  return sql`select customer_id from (${own}) mine`;
}

function chosenCustomer(customerId: string): SQL {
  return sql`select ${uuid.parse(customerId)}::uuid as customer_id`;
}

export interface BuyerOnWebsite {
  /** The signed-in identity user's id. */
  buyerUserId: string;
  websiteId: string;
}

export interface CustomerOnWebsite {
  customerId: string;
  websiteId: string;
}

/**
 * An SQL select of the ids of the products a signed-in buyer may see on a website, as one
 * column `product_id`, without surrounding parentheses: put it in `product_id in (...)`. The
 * buyer user's customer is derived inside the select, so a caller cannot ask for another
 * customer's catalog. A user id that is not a buyer user selects nothing, and so does a website
 * before the first build. Disabled products are left out even if the build is older than the
 * change.
 */
export function visibleProductIdsForBuyer(buyer: BuyerOnWebsite): SQL {
  const websiteId = uuid.parse(buyer.websiteId);
  return productIdsIn(servingContextId(buyersCustomer(buyer.buyerUserId), websiteId));
}

/** As visibleProductIdsForBuyer, for categories: one column `category_id`. */
export function visibleCategoryIdsForBuyer(buyer: BuyerOnWebsite): SQL {
  const websiteId = uuid.parse(buyer.websiteId);
  return categoryIdsIn(servingContextId(buyersCustomer(buyer.buyerUserId), websiteId));
}

/**
 * The products a customer chosen by an admin may see on a website. Admin-side only (preview and
 * support): the caller has already checked the admin may see this customer.
 */
export function visibleProductIds(customer: CustomerOnWebsite): SQL {
  const websiteId = uuid.parse(customer.websiteId);
  return productIdsIn(servingContextId(chosenCustomer(customer.customerId), websiteId));
}

/** As visibleProductIds, for categories. Admin-side only. */
export function visibleCategoryIds(customer: CustomerOnWebsite): SQL {
  const websiteId = uuid.parse(customer.websiteId);
  return categoryIdsIn(servingContextId(chosenCustomer(customer.customerId), websiteId));
}

/** Which kind of context served a customer in the last build, or none. Admin-side only. */
export function servingContextTarget(customer: CustomerOnWebsite): SQL {
  const websiteId = uuid.parse(customer.websiteId);
  const context = servingContextId(chosenCustomer(customer.customerId), websiteId);
  return sql`select target from ${contexts} where id = (${context})`;
}

export const listVisibleProductsQuerySchema = pageQuerySchema.extend({
  websiteId: z.uuid(),
  customerId: z.uuid(),
});

export type ListVisibleProductsQuery = z.input<typeof listVisibleProductsQuerySchema>;

export interface VisibleProductPage {
  productIds: string[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

/**
 * The ids of the products a customer may see on a website, from the last build, a page at a
 * time in id order. Admin-side only.
 */
export async function listVisibleProducts(
  db: Database,
  query: ListVisibleProductsQuery,
): Promise<VisibleProductPage> {
  const q = listVisibleProductsQuerySchema.parse(query);
  const [website, customer] = await Promise.all([
    findWebsite(db, q.websiteId),
    findCustomer(db, q.customerId),
  ]);
  if (!website) throw new VisibilityError('website_not_found', 'No such website');
  if (!customer) throw new VisibilityError('customer_not_found', 'No such customer');
  const ids = visibleProductIds({ customerId: q.customerId, websiteId: q.websiteId });
  const rows = await db.execute<{ product_id: string }>(
    sql`select product_id from (${ids}) v
      ${q.after === undefined ? sql`` : sql`where product_id > ${q.after}::uuid`}
      order by product_id
      limit ${q.limit + 1}`,
  );
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.product_id);
  return { productIds: items.map((r) => r.product_id), nextAfter };
}
