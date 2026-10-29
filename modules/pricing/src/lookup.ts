import { customerGroupMembership, reachableCustomerIds } from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  compareDecimals,
  decimalToString,
  isCurrencyCode,
  money,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { combinedPriceListTargets, combinedPrices } from './db/schema.js';
import { storedQuantity } from './quantity.js';

// Price lookups read only the combined price lists that the last build wrote (ADR 0011). They
// never walk price lists or assignments, so they cost one indexed read.

export interface PriceRequest {
  websiteId: string;
  productId: string;
  unitCode: string;
  /** The quantity being bought, already checked against the product unit's precision. */
  quantity: Decimal;
  currency: CurrencyCode;
  now: Date;
}

/**
 * The price a customer gets, or why there is none: `no_price` (no price list in the built chain
 * prices this), `needs_rebuild` (the customer has its own price lists but has changed customer
 * group since the last build), or `customer_not_found`.
 */
export type PriceLookup =
  | {
      found: true;
      unitPrice: Money;
      /** The tier's minimum quantity, for example "100". */
      minQuantity: string;
      /** The price list the price came from. */
      priceListId: string;
    }
  | { found: false; reason: 'no_price' | 'needs_rebuild' | 'customer_not_found' };

const lookupRow = z.object({
  customer_exists: z.boolean(),
  needs_rebuild: z.boolean(),
  amount_minor: z.string().nullable(),
  min_quantity: z.string().nullable(),
  price_list_id: z.string().nullable(),
});

function assertQuantity(quantity: Decimal): void {
  if (compareDecimals(quantity, { units: 0n, scale: 0 }) <= 0) {
    throw new RangeError('A quantity must be greater than zero');
  }
}

/**
 * One query: find the customer and its group, pick the combined price list that serves it on
 * the website, and read the tier for the quantity at `now`. `customer` selects at most one
 * customer id.
 */
async function lookup(db: Database, customer: SQL, request: PriceRequest): Promise<PriceLookup> {
  assertQuantity(request.quantity);
  const websiteId = z.uuid().parse(request.websiteId);
  const productId = z.uuid().parse(request.productId);
  if (!isCurrencyCode(request.currency)) throw new TypeError('Unsupported currency');
  const t = combinedPriceListTargets;
  const [raw] = await db.execute(sql`
    with who as (select customer_id from (${customer}) c limit 1),
    grp as (
      select m.group_id from (${customerGroupMembership()}) m
      join who on who.customer_id = m.customer_id
    ),
    own as (
      select customer_group_id, combined_price_list_id from ${t}
      where website_id = ${websiteId} and target = 'customer'
        and target_id = (select customer_id from who)
    ),
    chosen as (
      select
        exists (select 1 from grp) as customer_exists,
        (exists (select 1 from own) and not exists (
          select 1 from own where customer_group_id is not distinct from (select group_id from grp)
        )) as needs_rebuild,
        case when exists (select 1 from own) then
          (select combined_price_list_id from own
            where customer_group_id is not distinct from (select group_id from grp))
        else coalesce(
          (select combined_price_list_id from ${t}
            where website_id = ${websiteId} and target = 'customer_group'
              and target_id = (select group_id from grp)),
          (select combined_price_list_id from ${t}
            where website_id = ${websiteId} and target = 'website' and target_id = ${websiteId})
        ) end as combined_price_list_id
    )
    select chosen.customer_exists, chosen.needs_rebuild,
      p.amount_minor::text as amount_minor, p.tier_min_quantity::text as min_quantity,
      p.price_list_id::text as price_list_id
    from chosen
    left join lateral (
      select amount_minor, tier_min_quantity, price_list_id from ${combinedPrices}
      where combined_price_list_id = chosen.combined_price_list_id
        and chosen.customer_exists
        and product_id = ${productId} and unit_code = ${request.unitCode}
        and currency = ${request.currency}
        and min_quantity <= ${decimalToString(request.quantity)}::numeric
        and (valid_from is null or valid_from <= ${request.now.toISOString()}::timestamptz)
        and (valid_until is null or valid_until > ${request.now.toISOString()}::timestamptz)
      order by min_quantity desc
      limit 1
    ) p on true`);
  const row = lookupRow.parse(raw);
  if (!row.customer_exists) return { found: false, reason: 'customer_not_found' };
  if (row.needs_rebuild) return { found: false, reason: 'needs_rebuild' };
  if (row.amount_minor === null || row.min_quantity === null || row.price_list_id === null) {
    return { found: false, reason: 'no_price' };
  }
  return {
    found: true,
    unitPrice: money(BigInt(row.amount_minor), request.currency),
    minQuantity: storedQuantity(row.min_quantity),
    priceListId: row.price_list_id,
  };
}

/**
 * The price a customer gets on a website, from the combined price list. Admin-side: the caller
 * has already checked the admin may see this customer's prices.
 */
export async function findPrice(
  db: Database,
  request: PriceRequest & { customerId: string },
): Promise<PriceLookup> {
  const customerId = z.uuid().parse(request.customerId);
  return lookup(db, sql`select ${customerId}::uuid as customer_id`, request);
}

/**
 * The price a signed-in buyer gets on a website. The buyer user's customer is derived inside
 * the query from the identity user id, so a caller cannot ask for another customer's prices.
 * A user id that is not a buyer user gets `customer_not_found`.
 */
export async function findPriceForBuyer(
  db: Database,
  request: PriceRequest & { buyerUserId: string },
): Promise<PriceLookup> {
  const own = reachableCustomerIds(request.buyerUserId, 'my_customer');
  return lookup(db, sql`select customer_id from (${own}) mine`, request);
}
