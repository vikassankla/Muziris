import { buyerScope, getBuyerAccess, type BuyerAccess } from '@muziris/access';
import { findProductsWithin, parseQuantity, quantityToString } from '@muziris/catalog';
import { descendantCustomerIds, findBuyerUser } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { compareDecimals, parseDecimal } from '@muziris/money';
import { visibleProductIdsForBuyer } from '@muziris/visibility';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  MAX_LINES_PER_LIST,
  MAX_LISTS_PER_OWNER,
  shoppingListLines,
  shoppingLists,
} from './db/schema.js';

// Shopping lists (ADR 0018). Every read and change is scoped in the query to what the buyer may
// reach with shopping_list.view or shopping_list.manage at their access level (FR-AC-3), and a
// product is added only while the buyer may see it (FR-VI-4).

export interface ShoppingListLine {
  id: string;
  position: number;
  productId: string;
  unitCode: string;
  /** A decimal string without trailing zeros, such as "12" or "2.5". */
  quantity: string;
  note: string | null;
}

export interface ShoppingListSummary {
  id: string;
  websiteId: string;
  customerId: string;
  ownerId: string;
  name: string;
  lineCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShoppingList extends ShoppingListSummary {
  lines: ShoppingListLine[];
}

export interface ShoppingListPage {
  lists: ShoppingListSummary[];
  nextAfter: string | null;
}

export type LineProblemCode = 'product_not_available' | 'unit_not_sold' | 'invalid_quantity';

/** A line that cannot go on a list; `index` counts from 0 in the request. */
export interface LineProblem {
  index: number;
  code: LineProblemCode;
  message: string;
}

/** Why a change was refused. Each is safe to show to the buyer. */
export type ShoppingListRefusal =
  /** Not a buyer user, or no shopping_list.manage. */
  | { code: 'not_allowed' }
  /** No such list, or not one the buyer may reach. */
  | { code: 'list_not_found' }
  | { code: 'line_not_found' }
  | { code: 'too_many_lists'; limit: number }
  | { code: 'too_many_lines'; limit: number }
  /** Moving lines to the list they are on. */
  | { code: 'same_list' }
  | { code: 'line_problems'; lines: LineProblem[] };

export type ShoppingListResult =
  { ok: true; list: ShoppingList } | { ok: false; refusal: ShoppingListRefusal };

export type DeleteShoppingListResult = { ok: true } | { ok: false; refusal: ShoppingListRefusal };

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 50;

const id = z.uuid();
const name = z.string().trim().min(1, 'Give the list a name').max(100);
const note = z.string().trim().max(500).nullable();

const newLineSchema = z.object({
  productId: z.uuid(),
  unitCode: z.string().min(1).max(64),
  /** A decimal string at the unit's precision, above zero. */
  quantity: z.string().trim().min(1).max(40),
  note: note.optional(),
});
export type NewShoppingListLine = z.input<typeof newLineSchema>;

const listQuerySchema = z.object({
  websiteId: z.uuid(),
  /** The previous page's nextAfter. */
  after: z.string().max(200).optional(),
  limit: z.int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type ListShoppingListsQuery = z.input<typeof listQuerySchema>;

interface Buyer {
  buyerUserId: string;
  customerId: string;
  access: BuyerAccess;
}

async function buyerOf(db: Database, buyerUserId: string): Promise<Buyer | undefined> {
  const parsed = id.safeParse(buyerUserId);
  if (!parsed.success) return undefined;
  const buyer = await findBuyerUser(db, parsed.data);
  if (!buyer) return undefined;
  return {
    buyerUserId: parsed.data,
    customerId: buyer.customerId,
    access: await getBuyerAccess(db, parsed.data),
  };
}

/** The lists this buyer may reach with the permission, as a predicate on shopping_list. */
function reach(buyer: Buyer, permission: 'shopping_list.view' | 'shopping_list.manage'): SQL {
  return buyerScope(
    buyer.access,
    permission,
    {
      buyerUserId: buyer.buyerUserId,
      customerId: buyer.customerId,
      descendantCustomerIds: descendantCustomerIds(buyer.customerId),
    },
    { ownerBuyerUserId: shoppingLists.ownerId, customerId: shoppingLists.customerId },
  );
}

// Written with table names: inside the subquery drizzle would print the outer id as a bare "id",
// which Postgres would read as the line's own id.
const lineCount = sql<number>`(select count(*)::int from shopping_list_line l where l.list_id = "shopping_list"."id")`;

type ListRow = typeof shoppingLists.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function summary(row: ListRow, lines: number): ShoppingListSummary {
  return {
    id: row.id,
    websiteId: row.websiteId,
    customerId: row.customerId,
    ownerId: row.ownerId,
    name: row.name,
    lineCount: lines,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** "12.500000" from the numeric column, as "12.5". */
function storedQuantity(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

async function loadList(db: Database | Tx, row: ListRow): Promise<ShoppingList> {
  const lines = await db
    .select()
    .from(shoppingListLines)
    .where(eq(shoppingListLines.listId, row.id))
    .orderBy(asc(shoppingListLines.position));
  return {
    ...summary(row, lines.length),
    lines: lines.map((l) => ({
      id: l.id,
      position: l.position,
      productId: l.productId,
      unitCode: l.unitCode,
      quantity: storedQuantity(l.quantity),
      note: l.note,
    })),
  };
}

// The page cursor is the last list's updated time and id: newest first, ties by id.
function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return `${row.updatedAt.toISOString()}_${row.id}`;
}

function decodeCursor(after: string): { updatedAt: Date; id: string } | undefined {
  const [at, listId] = after.split('_');
  const updatedAt = new Date(at ?? '');
  const parsed = id.safeParse(listId);
  if (Number.isNaN(updatedAt.getTime()) || !parsed.success) return undefined;
  return { updatedAt, id: parsed.data };
}

/** Lists after the cursor in newest-first order. */
function afterCursor(cursor: { updatedAt: Date; id: string }): SQL {
  return sql`(${shoppingLists.updatedAt}, ${shoppingLists.id}) < (${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

/** The lists a buyer may see on a website, most recently changed first. */
export async function listShoppingLists(
  db: Database,
  buyerUserId: string,
  query: ListShoppingListsQuery,
): Promise<ShoppingListPage> {
  const q = listQuerySchema.parse(query);
  const buyer = await buyerOf(db, buyerUserId);
  if (!buyer) return { lists: [], nextAfter: null };
  const conditions: SQL[] = [
    reach(buyer, 'shopping_list.view'),
    eq(shoppingLists.websiteId, q.websiteId),
  ];
  const cursor = q.after === undefined ? undefined : decodeCursor(q.after);
  if (cursor) {
    conditions.push(afterCursor(cursor));
  }
  const rows = await db
    .select({ list: shoppingLists, lines: lineCount })
    .from(shoppingLists)
    .where(and(...conditions))
    .orderBy(desc(shoppingLists.updatedAt), desc(shoppingLists.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    lists: page.map((r) => summary(r.list, r.lines)),
    nextAfter: rows.length > q.limit && last ? encodeCursor(last.list) : null,
  };
}

/** One list with its lines, if the buyer may see it on this website. */
export async function findShoppingList(
  db: Database,
  buyerUserId: string,
  websiteId: string,
  listId: string,
): Promise<ShoppingList | undefined> {
  if (!id.safeParse(listId).success || !id.safeParse(websiteId).success) return undefined;
  const buyer = await buyerOf(db, buyerUserId);
  if (!buyer) return undefined;
  const [row] = await db
    .select()
    .from(shoppingLists)
    .where(
      and(
        eq(shoppingLists.id, listId),
        eq(shoppingLists.websiteId, websiteId),
        reach(buyer, 'shopping_list.view'),
      ),
    );
  return row ? loadList(db, row) : undefined;
}

/**
 * Runs a change on one list the buyer may manage, holding the list's row lock so line counts and
 * positions stay right when two changes race.
 */
async function withManagedList(
  db: Database,
  buyerUserId: string,
  websiteId: string,
  listId: string,
  change: (tx: Tx, list: ListRow, buyer: Buyer) => Promise<void>,
): Promise<ShoppingListResult> {
  const buyer = await buyerOf(db, buyerUserId);
  if (buyer?.access.get('shopping_list.manage') === undefined) {
    return { ok: false, refusal: { code: 'not_allowed' } };
  }
  if (!id.safeParse(listId).success || !id.safeParse(websiteId).success) {
    return { ok: false, refusal: { code: 'list_not_found' } };
  }
  return db
    .transaction(async (tx): Promise<ShoppingListResult> => {
      const [row] = await tx
        .select()
        .from(shoppingLists)
        .where(
          and(
            eq(shoppingLists.id, listId),
            eq(shoppingLists.websiteId, websiteId),
            reach(buyer, 'shopping_list.manage'),
          ),
        )
        .for('update');
      if (!row) return { ok: false, refusal: { code: 'list_not_found' } };
      // A refusal throws RefusedChange, which rolls back whatever the change wrote.
      await change(tx, row, buyer);
      const [touched] = await tx
        .update(shoppingLists)
        .set({ updatedAt: sql`now()` })
        .where(eq(shoppingLists.id, row.id))
        .returning();
      return { ok: true as const, list: await loadList(tx, touched ?? row) };
    })
    .catch((error: unknown): ShoppingListResult => {
      if (error instanceof RefusedChange) return { ok: false, refusal: error.refusal };
      throw error;
    });
}

/** Thrown inside a transaction to roll it back with a refusal. */
class RefusedChange extends Error {
  readonly refusal: ShoppingListRefusal;
  constructor(refusal: ShoppingListRefusal) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

/** Takes the owner's lock and checks they may own one more list. */
async function roomForList(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shopping_list:${ownerId}`}))`);
  const [row] = await tx
    .select({ n: count() })
    .from(shoppingLists)
    .where(eq(shoppingLists.ownerId, ownerId));
  if ((row?.n ?? 0) >= MAX_LISTS_PER_OWNER) {
    throw new RefusedChange({ code: 'too_many_lists', limit: MAX_LISTS_PER_OWNER });
  }
}

/** A new, empty list owned by the buyer, for their customer. */
export async function createShoppingList(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; name: string },
): Promise<ShoppingListResult> {
  const buyer = await buyerOf(db, buyerUserId);
  if (buyer?.access.get('shopping_list.manage') === undefined) {
    return { ok: false, refusal: { code: 'not_allowed' } };
  }
  const websiteId = id.parse(input.websiteId);
  const listName = name.parse(input.name);
  try {
    return await db.transaction(async (tx) => {
      await roomForList(tx, buyer.buyerUserId);
      const [row] = await tx
        .insert(shoppingLists)
        .values({
          websiteId,
          customerId: buyer.customerId,
          ownerId: buyer.buyerUserId,
          name: listName,
        })
        .returning();
      if (!row) throw new Error('The new shopping list was not returned');
      return { ok: true as const, list: { ...summary(row, 0), lines: [] } };
    });
  } catch (error) {
    if (error instanceof RefusedChange) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

export async function renameShoppingList(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; listId: string; name: string },
): Promise<ShoppingListResult> {
  const listName = name.parse(input.name);
  return withManagedList(db, buyerUserId, input.websiteId, input.listId, async (tx, list) => {
    await tx.update(shoppingLists).set({ name: listName }).where(eq(shoppingLists.id, list.id));
  });
}

export async function deleteShoppingList(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; listId: string },
): Promise<DeleteShoppingListResult> {
  const buyer = await buyerOf(db, buyerUserId);
  if (buyer?.access.get('shopping_list.manage') === undefined) {
    return { ok: false, refusal: { code: 'not_allowed' } };
  }
  if (!id.safeParse(input.listId).success || !id.safeParse(input.websiteId).success) {
    return { ok: false, refusal: { code: 'list_not_found' } };
  }
  const deleted = await db
    .delete(shoppingLists)
    .where(
      and(
        eq(shoppingLists.id, input.listId),
        eq(shoppingLists.websiteId, input.websiteId),
        reach(buyer, 'shopping_list.manage'),
      ),
    )
    .returning({ id: shoppingLists.id });
  return deleted.length > 0 ? { ok: true } : { ok: false, refusal: { code: 'list_not_found' } };
}

interface CheckedLine {
  productId: string;
  unitCode: string;
  quantity: string;
  note: string | null | undefined;
}

/**
 * Checks lines against what the buyer may see now: the product visible and enabled, sold in the
 * unit, and the quantity above zero at the unit's precision.
 */
async function checkLines(
  db: Database,
  buyer: Buyer,
  websiteId: string,
  lines: readonly NewShoppingListLine[],
): Promise<{ ok: true; lines: CheckedLine[] } | { ok: false; problems: LineProblem[] }> {
  const parsed = z.array(newLineSchema).min(1).max(MAX_LINES_PER_LIST).parse(lines);
  const products = new Map(
    (
      await findProductsWithin(
        db,
        visibleProductIdsForBuyer({ buyerUserId: buyer.buyerUserId, websiteId }),
        [...new Set(parsed.map((l) => l.productId))],
      )
    )
      .filter((p) => p.status === 'enabled')
      .map((p) => [p.id, p]),
  );
  const problems: LineProblem[] = [];
  const checked: CheckedLine[] = [];
  parsed.forEach((line, index) => {
    const product = products.get(line.productId);
    if (!product) {
      problems.push({
        index,
        code: 'product_not_available',
        message: 'This product cannot be added',
      });
      return;
    }
    const unit = product.units.find((u) => u.code === line.unitCode);
    if (!unit) {
      problems.push({
        index,
        code: 'unit_not_sold',
        message: `${product.sku} is not sold in that unit`,
      });
      return;
    }
    try {
      const quantity = parseQuantity(line.quantity, unit);
      if (compareDecimals(quantity, parseDecimal('0')) <= 0) {
        throw new RangeError('Enter a quantity more than 0');
      }
      checked.push({
        productId: product.id,
        unitCode: unit.code,
        quantity: quantityToString(quantity),
        note: line.note,
      });
    } catch (error) {
      problems.push({
        index,
        code: 'invalid_quantity',
        message: error instanceof RangeError ? error.message : 'Not a valid quantity',
      });
    }
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, lines: checked };
}

/**
 * Puts lines on a list inside the transaction: a product and unit already there gets the
 * quantity added (and the note replaced when one is given); a new one goes last.
 */
async function putLines(tx: Tx, listId: string, lines: readonly CheckedLine[]): Promise<void> {
  for (const line of lines) {
    const [existing] = await tx
      .select({ id: shoppingListLines.id })
      .from(shoppingListLines)
      .where(
        and(
          eq(shoppingListLines.listId, listId),
          eq(shoppingListLines.productId, line.productId),
          eq(shoppingListLines.unitCode, line.unitCode),
        ),
      );
    if (existing) {
      await tx
        .update(shoppingListLines)
        .set({
          quantity: sql`${shoppingListLines.quantity} + ${line.quantity}::numeric`,
          ...(line.note === undefined ? {} : { note: line.note === '' ? null : line.note }),
          updatedAt: sql`now()`,
        })
        .where(eq(shoppingListLines.id, existing.id));
      continue;
    }
    const [stats] = await tx
      .select({
        n: count(),
        last: sql<number>`coalesce(max(${shoppingListLines.position}), 0)::int`,
      })
      .from(shoppingListLines)
      .where(eq(shoppingListLines.listId, listId));
    if ((stats?.n ?? 0) >= MAX_LINES_PER_LIST) {
      throw new RefusedChange({ code: 'too_many_lines', limit: MAX_LINES_PER_LIST });
    }
    await tx.insert(shoppingListLines).values({
      listId,
      position: (stats?.last ?? 0) + 1,
      productId: line.productId,
      unitCode: line.unitCode,
      quantity: line.quantity,
      note: line.note === undefined || line.note === '' ? null : line.note,
    });
  }
}

/** Adds lines to a list; nothing is added when any line has a problem. */
export async function addShoppingListLines(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; listId: string; lines: readonly NewShoppingListLine[] },
): Promise<ShoppingListResult> {
  return withManagedList(
    db,
    buyerUserId,
    input.websiteId,
    input.listId,
    async (tx, list, buyer) => {
      const checked = await checkLines(db, buyer, list.websiteId, input.lines);
      if (!checked.ok) throw new RefusedChange({ code: 'line_problems', lines: checked.problems });
      await putLines(tx, list.id, checked.lines);
    },
  );
}

/** Changes one line's quantity, unit or note. A new unit must not already be on the list. */
export async function updateShoppingListLine(
  db: Database,
  buyerUserId: string,
  input: {
    websiteId: string;
    listId: string;
    lineId: string;
    quantity?: string;
    unitCode?: string;
    note?: string | null;
  },
): Promise<ShoppingListResult> {
  return withManagedList(
    db,
    buyerUserId,
    input.websiteId,
    input.listId,
    async (tx, list, buyer) => {
      if (!id.safeParse(input.lineId).success) throw new RefusedChange({ code: 'line_not_found' });
      const [line] = await tx
        .select()
        .from(shoppingListLines)
        .where(and(eq(shoppingListLines.id, input.lineId), eq(shoppingListLines.listId, list.id)));
      if (!line) throw new RefusedChange({ code: 'line_not_found' });
      const checked = await checkLines(db, buyer, list.websiteId, [
        {
          productId: line.productId,
          unitCode: input.unitCode ?? line.unitCode,
          quantity: input.quantity ?? storedQuantity(line.quantity),
        },
      ]);
      if (!checked.ok) throw new RefusedChange({ code: 'line_problems', lines: checked.problems });
      const [next] = checked.lines;
      if (!next) throw new RefusedChange({ code: 'line_not_found' });
      const noteValue = input.note === undefined ? line.note : (note.parse(input.note) ?? null);
      if (next.unitCode !== line.unitCode) {
        // Changing the unit merges into a line already in that unit, if there is one.
        await tx.delete(shoppingListLines).where(eq(shoppingListLines.id, line.id));
        await putLines(tx, list.id, [{ ...next, note: noteValue }]);
        return;
      }
      await tx
        .update(shoppingListLines)
        .set({ quantity: next.quantity, note: noteValue, updatedAt: sql`now()` })
        .where(eq(shoppingListLines.id, line.id));
    },
  );
}

export async function removeShoppingListLines(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; listId: string; lineIds: readonly string[] },
): Promise<ShoppingListResult> {
  const lineIds = z.array(id).min(1).max(MAX_LINES_PER_LIST).parse(input.lineIds);
  return withManagedList(db, buyerUserId, input.websiteId, input.listId, async (tx, list) => {
    const removed = await tx
      .delete(shoppingListLines)
      .where(and(eq(shoppingListLines.listId, list.id), inArray(shoppingListLines.id, lineIds)))
      .returning({ id: shoppingListLines.id });
    if (removed.length !== new Set(lineIds).size) {
      throw new RefusedChange({ code: 'line_not_found' });
    }
  });
}

/**
 * Moves lines to another list the buyer may manage, merging into lines already there. The
 * answer is the list they moved to.
 */
export async function moveShoppingListLines(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; fromListId: string; toListId: string; lineIds: readonly string[] },
): Promise<ShoppingListResult> {
  const lineIds = z.array(id).min(1).max(MAX_LINES_PER_LIST).parse(input.lineIds);
  if (input.fromListId === input.toListId) return { ok: false, refusal: { code: 'same_list' } };
  return withManagedList(
    db,
    buyerUserId,
    input.websiteId,
    input.toListId,
    async (tx, target, buyer) => {
      if (!id.safeParse(input.fromListId).success)
        throw new RefusedChange({ code: 'list_not_found' });
      const [source] = await tx
        .select()
        .from(shoppingLists)
        .where(
          and(
            eq(shoppingLists.id, input.fromListId),
            eq(shoppingLists.websiteId, target.websiteId),
            reach(buyer, 'shopping_list.manage'),
          ),
        )
        .for('update');
      if (!source) throw new RefusedChange({ code: 'list_not_found' });
      const moved = await tx
        .delete(shoppingListLines)
        .where(and(eq(shoppingListLines.listId, source.id), inArray(shoppingListLines.id, lineIds)))
        .returning();
      if (moved.length !== new Set(lineIds).size)
        throw new RefusedChange({ code: 'line_not_found' });
      moved.sort((a, b) => a.position - b.position);
      await putLines(
        tx,
        target.id,
        moved.map((l) => ({
          productId: l.productId,
          unitCode: l.unitCode,
          quantity: storedQuantity(l.quantity),
          note: l.note ?? undefined,
        })),
      );
      await tx
        .update(shoppingLists)
        .set({ updatedAt: sql`now()` })
        .where(eq(shoppingLists.id, source.id));
    },
  );
}

/**
 * A copy of a list, owned by the buyer, for their own customer. Only lines whose products the
 * buyer may still see are copied.
 */
export async function duplicateShoppingList(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; listId: string; name: string },
): Promise<ShoppingListResult> {
  const listName = name.parse(input.name);
  const original = await findShoppingList(db, buyerUserId, input.websiteId, input.listId);
  if (!original) return { ok: false, refusal: { code: 'list_not_found' } };
  const created = await createShoppingList(db, buyerUserId, {
    websiteId: original.websiteId,
    name: listName,
  });
  if (!created.ok || original.lines.length === 0) return created;
  const buyer = await buyerOf(db, buyerUserId);
  if (!buyer) return { ok: false, refusal: { code: 'not_allowed' } };
  const visible = new Set(
    (
      await findProductsWithin(
        db,
        visibleProductIdsForBuyer({
          buyerUserId: buyer.buyerUserId,
          websiteId: original.websiteId,
        }),
        [...new Set(original.lines.map((l) => l.productId))],
      )
    )
      .filter((p) => p.status === 'enabled')
      .map((p) => p.id),
  );
  const lines = original.lines.filter((l) => visible.has(l.productId));
  if (lines.length === 0) return created;
  return withManagedList(db, buyerUserId, original.websiteId, created.list.id, async (tx, list) => {
    await putLines(
      tx,
      list.id,
      lines.map((l) => ({
        productId: l.productId,
        unitCode: l.unitCode,
        quantity: l.quantity,
        note: l.note ?? undefined,
      })),
    );
  });
}

// Admin reads (customer.view), for support staff: every list of one customer.

export async function listShoppingListsForCustomer(
  db: Database,
  customerId: string,
  query: { after?: string; limit?: number } = {},
): Promise<ShoppingListPage> {
  const limit = z.int().min(1).max(200).default(PAGE_LIMIT_DEFAULT).parse(query.limit);
  const conditions: SQL[] = [eq(shoppingLists.customerId, id.parse(customerId))];
  const cursor = query.after === undefined ? undefined : decodeCursor(query.after);
  if (cursor) {
    conditions.push(afterCursor(cursor));
  }
  const rows = await db
    .select({ list: shoppingLists, lines: lineCount })
    .from(shoppingLists)
    .where(and(...conditions))
    .orderBy(desc(shoppingLists.updatedAt), desc(shoppingLists.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    lists: page.map((r) => summary(r.list, r.lines)),
    nextAfter: rows.length > limit && last ? encodeCursor(last.list) : null,
  };
}

export async function findShoppingListById(
  db: Database,
  listId: string,
): Promise<ShoppingList | undefined> {
  if (!id.safeParse(listId).success) return undefined;
  const [row] = await db.select().from(shoppingLists).where(eq(shoppingLists.id, listId));
  return row ? loadList(db, row) : undefined;
}
