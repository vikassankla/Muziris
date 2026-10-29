import { findProduct, parseQuantity, type ProductUnit } from '@muziris/catalog';
import type { Database } from '@muziris/db';
import {
  decimalToString,
  money,
  moneyFromDecimal,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from './changes.js';
import { priceLists, prices } from './db/schema.js';
import { PricingError, isUniqueViolation } from './errors.js';
import { pageQuerySchema, toPage } from './page.js';
import { findPriceList, toPriceList } from './price-lists.js';
import { storedQuantity } from './quantity.js';

/** Amounts stay below 10^15 minor units, so a price times a quantity never nears bigint limits. */
export const MAX_AMOUNT_MINOR = 10n ** 15n;

/** One price tier of a price list. */
export interface Price {
  id: string;
  priceListId: string;
  productId: string;
  unitCode: string;
  /** The smallest quantity this price applies to, as a decimal string ("1", "2.5"). */
  minQuantity: string;
  /** The unit price, in the price list's currency. */
  amount: Money;
  createdAt: Date;
  updatedAt: Date;
}

export interface PricePage {
  prices: Price[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

const idSchema = z.uuid();

/** Decimal strings only: a JSON number may already have lost the value that was typed. */
const decimalText = z.string().trim().min(1).max(40);

export const newPriceSchema = z.object({
  productId: z.uuid(),
  unitCode: z.string().min(1).max(32),
  minQuantity: decimalText.default('1'),
  amount: decimalText,
});

export type NewPrice = z.input<typeof newPriceSchema>;

export const priceChangesSchema = z.object({ amount: decimalText }).strict();

export type PriceChanges = z.input<typeof priceChangesSchema>;

export const listPricesQuerySchema = pageQuerySchema.extend({
  productId: z.uuid().optional(),
  unitCode: z.string().min(1).max(32).optional(),
});

export type ListPricesQuery = z.input<typeof listPricesQuerySchema>;

/**
 * Reads an amount in a currency from a decimal string. More decimals than the currency allows
 * are refused, never rounded; negative amounts and amounts of 10^15 minor units or more too.
 */
export function parseAmount(input: string, currency: CurrencyCode): Money {
  let amount: Money;
  try {
    amount = moneyFromDecimal(input, currency);
  } catch (error) {
    throw new PricingError(
      'invalid_amount',
      error instanceof RangeError ? error.message : 'Not a plain decimal amount',
    );
  }
  if (amount.minor < 0n) throw new PricingError('invalid_amount', 'A price cannot be negative');
  if (amount.minor >= MAX_AMOUNT_MINOR) {
    throw new PricingError('invalid_amount', 'The amount is too large');
  }
  return amount;
}

/** Reads a quantity in a product unit, refusing rather than rounding extra decimals. */
export function parseUnitQuantity(input: string, unit: Pick<ProductUnit, 'precision'>): Decimal {
  try {
    return parseQuantity(input, unit);
  } catch (error) {
    throw new PricingError(
      'invalid_quantity',
      error instanceof RangeError ? error.message : 'Not a plain decimal quantity',
    );
  }
}

/** Finds the product unit a product is sold in, through catalog's public interface. */
export async function productUnitOf(
  db: Database,
  productId: string,
  unitCode: string,
): Promise<ProductUnit> {
  const product = await findProduct(db, productId);
  if (!product) throw new PricingError('product_not_found', 'No such product');
  const unit = product.units.find((u) => u.code === unitCode);
  if (!unit) {
    throw new PricingError('product_unit_not_sold', 'The product is not sold in that product unit');
  }
  return unit;
}

function toPrice(row: typeof prices.$inferSelect, currency: CurrencyCode): Price {
  return {
    id: row.id,
    priceListId: row.priceListId,
    productId: row.productId,
    unitCode: row.unitCode,
    minQuantity: storedQuantity(row.minQuantity),
    amount: money(row.amountMinor, currency),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Adds a price tier to a price list. */
export async function addPrice(db: Database, priceListId: string, input: NewPrice): Promise<Price> {
  const values = newPriceSchema.parse(input);
  const list = await findPriceList(db, priceListId);
  if (!list) throw new PricingError('price_list_not_found', 'No such price list');
  const unit = await productUnitOf(db, values.productId, values.unitCode);
  const minQuantity = parseUnitQuantity(values.minQuantity, unit);
  const amount = parseAmount(values.amount, list.currency);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(prices)
        .values({
          priceListId: list.id,
          productId: values.productId,
          unitCode: unit.code,
          minQuantity: decimalToString(minQuantity),
          amountMinor: amount.minor,
        })
        .returning();
      if (!row) throw new Error('Price insert returned no row');
      await recordChange(tx);
      return toPrice(row, list.currency);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PricingError(
        'price_tier_taken',
        'The price list already has a price for this product, product unit and minimum quantity',
      );
    }
    throw error;
  }
}

/** Changes the amount of a price tier. */
export async function updatePrice(
  db: Database,
  priceId: string,
  changes: PriceChanges,
): Promise<Price> {
  const id = idSchema.parse(priceId);
  const values = priceChangesSchema.parse(changes);
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ list: priceLists })
      .from(prices)
      .innerJoin(priceLists, eq(priceLists.id, prices.priceListId))
      .where(eq(prices.id, id))
      .for('update', { of: prices });
    if (!found) throw new PricingError('price_not_found', 'No such price');
    const list = toPriceList(found.list);
    const amount = parseAmount(values.amount, list.currency);
    const [row] = await tx
      .update(prices)
      .set({ amountMinor: amount.minor, updatedAt: sql`now()` })
      .where(eq(prices.id, id))
      .returning();
    if (!row) throw new PricingError('price_not_found', 'No such price');
    await recordChange(tx);
    return toPrice(row, list.currency);
  });
}

export async function deletePrice(db: Database, priceId: string): Promise<void> {
  const id = idSchema.parse(priceId);
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(prices).where(eq(prices.id, id)).returning({ id: prices.id });
    if (deleted.length === 0) throw new PricingError('price_not_found', 'No such price');
    await recordChange(tx);
  });
}

/**
 * A price list's prices, a page at a time, by product, product unit and minimum quantity, so
 * the tiers of one product and unit come together, lowest first.
 */
export async function listPrices(
  db: Database,
  priceListId: string,
  query: ListPricesQuery = {},
): Promise<PricePage> {
  const q = listPricesQuerySchema.parse(query);
  const list = await findPriceList(db, priceListId);
  if (!list) throw new PricingError('price_list_not_found', 'No such price list');
  const conditions: SQL[] = [eq(prices.priceListId, list.id)];
  if (q.productId !== undefined) conditions.push(eq(prices.productId, q.productId));
  if (q.unitCode !== undefined) conditions.push(eq(prices.unitCode, q.unitCode));
  if (q.after !== undefined) {
    conditions.push(
      sql`(${prices.productId}, ${prices.unitCode}, ${prices.minQuantity}, ${prices.id}) >
        (select product_id, unit_code, min_quantity, id from ${prices} where id = ${q.after})`,
    );
  }
  const rows = await db
    .select()
    .from(prices)
    .where(and(...conditions))
    .orderBy(asc(prices.productId), asc(prices.unitCode), asc(prices.minQuantity), asc(prices.id))
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.id);
  return { prices: items.map((row) => toPrice(row, list.currency)), nextAfter };
}
