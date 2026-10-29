import { findCustomer } from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  isCurrencyCode,
  money,
  multiply,
  parseDecimal,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import { findWebsite } from '@muziris/platform';
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { targetRank } from './assignments.js';
import { getBuildState } from './build.js';
import { assignments, priceLists, prices } from './db/schema.js';
import { PricingError } from './errors.js';
import { findPrice, type PriceLookup } from './lookup.js';
import { toPriceList } from './price-lists.js';
import { parseUnitQuantity, productUnitOf } from './prices.js';
import { resolvePrice, type ChainEntry, type ChainStep } from './resolve.js';

/**
 * The rounding step for a line: unit price times quantity, rounded once, half up, to the
 * currency's minor unit (ADR 0011). Orders use the same step.
 */
export function lineAmount(unitPrice: Money, quantity: Decimal): Money {
  return multiply(unitPrice, quantity, 'half-up');
}

export const pricePreviewQuerySchema = z.object({
  customerId: z.uuid(),
  websiteId: z.uuid(),
  productId: z.uuid(),
  unitCode: z.string().min(1).max(32),
  /** A decimal string in the product unit's precision. */
  quantity: z.string().trim().min(1).max(40),
});

export type PricePreviewQuery = z.input<typeof pricePreviewQuerySchema>;

export interface PricePreview {
  currency: CurrencyCode;
  /** The quantity at the product unit's precision, for example "120" or "2.500". */
  quantity: Decimal;
  /** What a buyer of this customer gets now, from the last build. */
  price: (PriceLookup & { found: true }) | null;
  /** Why there is no price, when there is none. */
  reason: (PriceLookup & { found: false })['reason'] | null;
  /** Unit price times quantity, rounded once; null without a price. */
  lineAmount: Money | null;
  /** The chain as the price lists stand now, step by step; it may include unbuilt changes. */
  steps: ChainStep[];
  /** The price the chain gives now, before any build; differs from `price` until a build. */
  unbuiltPrice: ReturnType<typeof resolvePrice>['price'];
  pendingChanges: number;
}

/** Loads the customer's chain on a website with every tier for one product and product unit. */
async function loadChain(
  db: Database,
  input: { websiteId: string; customerId: string; groupId: string | null },
  productId: string,
  unitCode: string,
): Promise<ChainEntry[]> {
  const targets = [
    and(eq(assignments.target, 'customer'), eq(assignments.targetId, input.customerId)),
    and(eq(assignments.target, 'website'), eq(assignments.targetId, input.websiteId)),
  ];
  if (input.groupId !== null) {
    targets.push(
      and(eq(assignments.target, 'customer_group'), eq(assignments.targetId, input.groupId)),
    );
  }
  const rows = await db
    .select({ assignment: assignments, list: priceLists })
    .from(assignments)
    .innerJoin(priceLists, eq(priceLists.id, assignments.priceListId))
    .where(and(eq(assignments.websiteId, input.websiteId), or(...targets)))
    .orderBy(targetRank(assignments.target), assignments.priority);
  if (rows.length === 0) return [];
  const tiers = await db
    .select()
    .from(prices)
    .where(
      and(
        inArray(
          prices.priceListId,
          rows.map((r) => r.list.id),
        ),
        eq(prices.productId, productId),
        eq(prices.unitCode, unitCode),
      ),
    )
    .orderBy(prices.minQuantity);
  return rows.map((r): ChainEntry => {
    const list = toPriceList(r.list);
    const target = r.assignment.target;
    if (target !== 'customer' && target !== 'customer_group' && target !== 'website') {
      throw new Error(`Assignment ${r.assignment.id} has an unknown target`);
    }
    return {
      target,
      targetId: r.assignment.targetId,
      priority: r.assignment.priority,
      priceList: list,
      tiers: tiers
        .filter((p) => p.priceListId === list.id)
        .map((p) => ({
          minQuantity: parseDecimal(p.minQuantity),
          amount: money(p.amountMinor, list.currency),
        })),
    };
  });
}

/**
 * The admin's price preview: the price a customer gets for a quantity of a product on a
 * website, from the combined price list, with the chain explained step by step.
 */
export async function previewPrice(
  db: Database,
  query: PricePreviewQuery,
  now: Date,
): Promise<PricePreview> {
  const q = pricePreviewQuerySchema.parse(query);
  const [website, customer] = await Promise.all([
    findWebsite(db, q.websiteId),
    findCustomer(db, q.customerId),
  ]);
  if (!website) throw new PricingError('website_not_found', 'No such website');
  if (!customer) throw new PricingError('customer_not_found', 'No such customer');
  const unit = await productUnitOf(db, q.productId, q.unitCode);
  const quantity = parseUnitQuantity(q.quantity, unit);
  const currency = website.defaultCurrency;
  if (!isCurrencyCode(currency)) throw new Error(`Website ${website.id} has an unknown currency`);

  const [lookup, chain, state] = await Promise.all([
    findPrice(db, {
      customerId: customer.id,
      websiteId: website.id,
      productId: q.productId,
      unitCode: unit.code,
      quantity,
      currency,
      now,
    }),
    loadChain(
      db,
      { websiteId: website.id, customerId: customer.id, groupId: customer.groupId },
      q.productId,
      unit.code,
    ),
    getBuildState(db),
  ]);
  const resolution = resolvePrice(chain, { currency, quantity, now });
  return {
    currency,
    quantity,
    price: lookup.found ? lookup : null,
    reason: lookup.found ? null : lookup.reason,
    lineAmount: lookup.found ? lineAmount(lookup.unitPrice, quantity) : null,
    steps: resolution.steps,
    unbuiltPrice: resolution.price,
    pendingChanges: state.pendingChanges,
  };
}
