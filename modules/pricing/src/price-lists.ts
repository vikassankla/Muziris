import type { Database } from '@muziris/db';
import { isCurrencyCode, type CurrencyCode } from '@muziris/money';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from './changes.js';
import { assignments, priceLists, prices } from './db/schema.js';
import { PricingError, isCheckViolation, violatedConstraint } from './errors.js';
import { pageQuerySchema, toPage } from './page.js';

// Admin-side functions. Price lists are the organization's own data, so these are not scoped to
// a buyer; the admin API checks the admin's permission before calling them. Buyers see prices
// only through the combined price list (lookup.ts).

/** Derived from the active dates and the clock; never stored. */
export const PRICE_LIST_STATUSES = ['scheduled', 'active', 'expired'] as const;
export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];

export interface PriceList {
  id: string;
  name: string;
  currency: CurrencyCode;
  /** Active from this instant, inclusive; null for always. */
  activeFrom: Date | null;
  /** Active until this instant, exclusive; null for no end. */
  activeUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A price list as the admin list shows it, with its status and counts. */
export interface PriceListSummary extends PriceList {
  status: PriceListStatus;
  priceCount: number;
  assignmentCount: number;
}

export interface PriceListPage {
  priceLists: PriceListSummary[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

const idSchema = z.uuid();

/** An instant, as a Date or an ISO 8601 date and time with an offset ("2026-04-01T00:00:00+05:30"). */
const instantSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);

const nameSchema = z.string().trim().min(1).max(200);

export const newPriceListSchema = z.object({
  name: nameSchema,
  currency: z.string().refine(isCurrencyCode, 'Unsupported currency'),
  activeFrom: instantSchema.nullable().default(null),
  activeUntil: instantSchema.nullable().default(null),
});

export type NewPriceList = z.input<typeof newPriceListSchema>;

/** Fields an admin may change. The currency is fixed: a different currency is a new list. */
export const priceListChangesSchema = z
  .object({
    name: nameSchema,
    activeFrom: instantSchema.nullable(),
    activeUntil: instantSchema.nullable(),
  })
  .partial()
  .strict();

export type PriceListChanges = z.input<typeof priceListChangesSchema>;

export const listPriceListsQuerySchema = pageQuerySchema.extend({
  currency: z.string().refine(isCurrencyCode, 'Unsupported currency').optional(),
});

export type ListPriceListsQuery = z.input<typeof listPriceListsQuerySchema>;

/** Where a price list stands at `now`. */
export function priceListStatus(
  list: Pick<PriceList, 'activeFrom' | 'activeUntil'>,
  now: Date,
): PriceListStatus {
  if (list.activeFrom !== null && now < list.activeFrom) return 'scheduled';
  if (list.activeUntil !== null && now >= list.activeUntil) return 'expired';
  return 'active';
}

/** Whether a price list is active at `now`: from is inclusive, until is exclusive. */
export function isPriceListActive(
  list: Pick<PriceList, 'activeFrom' | 'activeUntil'>,
  now: Date,
): boolean {
  return priceListStatus(list, now) === 'active';
}

function assertDatesOrdered(activeFrom: Date | null, activeUntil: Date | null): void {
  if (activeFrom !== null && activeUntil !== null && activeUntil <= activeFrom) {
    throw new PricingError('active_dates_out_of_order', 'A price list must end after it starts');
  }
}

export function toPriceList(row: typeof priceLists.$inferSelect): PriceList {
  if (!isCurrencyCode(row.currency)) {
    throw new Error(`Price list ${row.id} has an unknown currency`);
  }
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    activeFrom: row.activeFrom,
    activeUntil: row.activeUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createPriceList(db: Database, input: NewPriceList): Promise<PriceList> {
  const values = newPriceListSchema.parse(input);
  assertDatesOrdered(values.activeFrom, values.activeUntil);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(priceLists).values(values).returning();
    if (!row) throw new Error('Price list insert returned no row');
    await recordChange(tx);
    return toPriceList(row);
  });
}

export async function findPriceList(
  db: Database,
  priceListId: string,
): Promise<PriceList | undefined> {
  const [row] = await db
    .select()
    .from(priceLists)
    .where(eq(priceLists.id, idSchema.parse(priceListId)))
    .limit(1);
  return row ? toPriceList(row) : undefined;
}

/** Price lists by name, a page at a time, with each one's status at `now` and its counts. */
export async function listPriceLists(
  db: Database,
  query: ListPriceListsQuery,
  now: Date,
): Promise<PriceListPage> {
  const q = listPriceListsQuerySchema.parse(query);
  const conditions: SQL[] = [];
  if (q.currency !== undefined) conditions.push(eq(priceLists.currency, q.currency));
  if (q.after !== undefined) {
    conditions.push(
      sql`(${priceLists.name}, ${priceLists.id}) > (select name, id from ${priceLists} where id = ${q.after})`,
    );
  }
  const rows = await db
    .select({
      list: priceLists,
      priceCount: sql<number>`(select count(*)::int from ${prices} p where p.price_list_id = ${priceLists}.id)`,
      assignmentCount: sql<number>`(select count(*)::int from ${assignments} a where a.price_list_id = ${priceLists}.id)`,
    })
    .from(priceLists)
    .where(and(...conditions))
    .orderBy(asc(priceLists.name), asc(priceLists.id))
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.list.id);
  return {
    priceLists: items.map((r) => {
      const list = toPriceList(r.list);
      return {
        ...list,
        status: priceListStatus(list, now),
        priceCount: r.priceCount,
        assignmentCount: r.assignmentCount,
      };
    }),
    nextAfter,
  };
}

/** Renames a price list or changes its active dates. */
export async function updatePriceList(
  db: Database,
  priceListId: string,
  changes: PriceListChanges,
): Promise<PriceList> {
  const id = idSchema.parse(priceListId);
  const values = priceListChangesSchema.parse(changes);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(priceLists)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(priceLists.id, id))
        .returning();
      if (!row) throw new PricingError('price_list_not_found', 'No such price list');
      await recordChange(tx);
      return toPriceList(row);
    });
  } catch (error) {
    if (
      isCheckViolation(error) &&
      violatedConstraint(error) === 'pricing_price_list_dates_ordered'
    ) {
      throw new PricingError('active_dates_out_of_order', 'A price list must end after it starts');
    }
    throw error;
  }
}

/** Deletes a price list with its prices and assignments. Buyers keep it until the next build. */
export async function deletePriceList(db: Database, priceListId: string): Promise<void> {
  const id = idSchema.parse(priceListId);
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(priceLists)
      .where(eq(priceLists.id, id))
      .returning({ id: priceLists.id });
    if (deleted.length === 0) throw new PricingError('price_list_not_found', 'No such price list');
    await recordChange(tx);
  });
}
