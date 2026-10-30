import { buyerScope, getBuyerAccess } from '@muziris/access';
import { descendantCustomerIds, findBuyerUser } from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  isCurrencyCode,
  money,
  parseDecimal,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import {
  listTransitionLog,
  performTransition,
  type Actor,
  type TransitionLogEntry,
  type TransitionRefusal,
} from '@muziris/workflow';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { orderAddresses, orderLines, orders, orderTaxLines } from './db/schema.js';
import { OrderError } from './errors.js';
import { ORDER_STEPS, orderWorkflow, type OrderStep, type OrderTransition } from './workflow.js';

// Reads of placed orders (ADR 0016). Buyer reads are scoped in the query with buyerScope and
// order.view (ADR 0006); admin reads assume the admin API has checked order.view.

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export interface OrderAddress {
  addressId: string;
  label: string;
  countryCode: string;
  line1: string;
  line2: string | null;
  city: string;
  regionCode: string;
  postalCode: string;
  gstin: string | null;
}

export interface OrderLine {
  lineNo: number;
  productId: string;
  sku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  quantity: Decimal;
  unitPrice: Money;
  subtotal: Money;
  discount: Money;
  net: Money;
  taxCode: string | null;
}

export interface OrderTax {
  lineNo: number | null;
  name: string;
  rate: string;
  taxable: Money;
  amount: Money;
}

/** An order list row. */
export interface OrderSummary {
  id: string;
  number: string;
  websiteId: string;
  customerId: string;
  customerName: string;
  placedBy: string;
  step: OrderStep;
  purchaseOrderNumber: string | null;
  grandTotal: Money;
  placedAt: Date;
}

/** A placed order with everything it shows. */
export interface Order extends OrderSummary {
  currency: CurrencyCode;
  paymentMethod: 'terms';
  paymentTermDays: number;
  dueOn: string;
  shippingMethod: string;
  taxProvider: string;
  subtotal: Money;
  discount: Money;
  shipping: Money;
  shippingDiscount: Money;
  tax: Money;
  lines: OrderLine[];
  taxes: OrderTax[];
  billingAddress: OrderAddress;
  shippingAddress: OrderAddress;
}

export interface OrderPage {
  orders: OrderSummary[];
  nextAfter: string | null;
}

const idSchema = z.uuid();
const stepSchema = z.enum(ORDER_STEPS);

type OrderRow = typeof orders.$inferSelect;

function currencyOf(row: OrderRow): CurrencyCode {
  if (!isCurrencyCode(row.currency))
    throw new Error(`Order ${row.number} has currency ${row.currency}`);
  return row.currency;
}

function toSummary(row: OrderRow): OrderSummary {
  const currency = currencyOf(row);
  return {
    id: row.id,
    number: row.number,
    websiteId: row.websiteId,
    customerId: row.customerId,
    customerName: row.customerName,
    placedBy: row.placedBy,
    step: stepSchema.parse(row.step),
    purchaseOrderNumber: row.purchaseOrderNumber,
    grandTotal: money(row.grandTotalMinor, currency),
    placedAt: row.placedAt,
  };
}

function toAddress(row: typeof orderAddresses.$inferSelect): OrderAddress {
  return {
    addressId: row.addressId,
    label: row.label,
    countryCode: row.countryCode,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    regionCode: row.regionCode,
    postalCode: row.postalCode,
    gstin: row.gstin,
  };
}

/** Loads lines, taxes and addresses for one order row. */
async function withDetails(db: Database, row: OrderRow): Promise<Order> {
  const currency = currencyOf(row);
  const m = (minor: bigint) => money(minor, currency);
  const [lines, taxes, addresses] = await Promise.all([
    db
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, row.id))
      .orderBy(asc(orderLines.lineNo)),
    db
      .select()
      .from(orderTaxLines)
      .where(eq(orderTaxLines.orderId, row.id))
      .orderBy(sql`${orderTaxLines.lineNo} nulls last`, asc(orderTaxLines.name)),
    db.select().from(orderAddresses).where(eq(orderAddresses.orderId, row.id)),
  ]);
  const billing = addresses.find((a) => a.role === 'billing');
  const shipping = addresses.find((a) => a.role === 'shipping');
  if (!billing || !shipping) throw new Error(`Order ${row.number} is missing an address`);
  return {
    ...toSummary(row),
    currency,
    paymentMethod: 'terms',
    paymentTermDays: row.paymentTermDays,
    dueOn: row.dueOn,
    shippingMethod: row.shippingMethod,
    taxProvider: row.taxProvider,
    subtotal: m(row.subtotalMinor),
    discount: m(row.discountMinor),
    shipping: m(row.shippingMinor),
    shippingDiscount: m(row.shippingDiscountMinor),
    tax: m(row.taxMinor),
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      unitCode: l.unitCode,
      unitName: l.unitName,
      // numeric(18, 6) comes back with six decimals; trailing zeros do not change the value.
      quantity: parseDecimal(l.quantity),
      unitPrice: m(l.unitPriceMinor),
      subtotal: m(l.subtotalMinor),
      discount: m(l.discountMinor),
      net: m(l.netMinor),
      taxCode: l.taxCode,
    })),
    taxes: taxes.map((x) => ({
      lineNo: x.lineNo,
      name: x.name,
      rate: x.rate,
      taxable: m(x.taxableMinor),
      amount: m(x.amountMinor),
    })),
    billingAddress: toAddress(billing),
    shippingAddress: toAddress(shipping),
  };
}

/** One order by id, for admins and for this module. */
export async function findOrderById(db: Database, orderId: string): Promise<Order | undefined> {
  const id = idSchema.safeParse(orderId);
  if (!id.success) return undefined;
  const [row] = await db.select().from(orders).where(eq(orders.id, id.data)).limit(1);
  return row ? withDetails(db, row) : undefined;
}

/** One order by its number (MZ-000123), for admins. */
export async function findOrderByNumber(db: Database, number: string): Promise<Order | undefined> {
  const [row] = await db
    .select()
    .from(orders)
    .where(eq(orders.number, z.string().max(40).parse(number).toUpperCase()))
    .limit(1);
  return row ? withDetails(db, row) : undefined;
}

export const listOrdersQuerySchema = z.object({
  websiteId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  step: stepSchema.optional(),
  after: z.uuid().optional(),
  limit: z.int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});

export type ListOrdersQuery = z.input<typeof listOrdersQuerySchema>;

/** Newest first, with the id as the tie breaker; `after` is the previous page's last id. */
async function page(db: Database, conditions: SQL[], after: string | undefined, limit: number) {
  if (after !== undefined) {
    conditions.push(
      sql`(${orders.placedAt}, ${orders.id}) < (select placed_at, id from ${orders} where id = ${after})`,
    );
  }
  const rows = await db
    .select()
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.placedAt), desc(orders.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    orders: items.map(toSummary),
    nextAfter: rows.length > limit && last !== undefined ? last.id : null,
  };
}

/** Every order, newest first, for admins. */
export async function listOrders(db: Database, query: ListOrdersQuery): Promise<OrderPage> {
  const q = listOrdersQuerySchema.parse(query);
  const conditions: SQL[] = [];
  if (q.websiteId !== undefined) conditions.push(eq(orders.websiteId, q.websiteId));
  if (q.customerId !== undefined) conditions.push(eq(orders.customerId, q.customerId));
  if (q.step !== undefined) conditions.push(eq(orders.step, q.step));
  return page(db, conditions, q.after, q.limit);
}

/**
 * The predicate for orders a buyer may see with order.view: their own, their customer's, or
 * with subsidiaries too, by their access level. No buyer user or no permission sees nothing.
 */
async function buyerOrders(db: Database, buyerUserId: string): Promise<SQL> {
  const id = idSchema.parse(buyerUserId);
  const buyer = await findBuyerUser(db, id);
  if (!buyer) return sql`false`;
  const access = await getBuyerAccess(db, id);
  return buyerScope(
    access,
    'order.view',
    {
      buyerUserId: id,
      customerId: buyer.customerId,
      descendantCustomerIds: descendantCustomerIds(buyer.customerId),
    },
    { ownerBuyerUserId: orders.placedBy, customerId: orders.customerId },
  );
}

export const listOrdersForBuyerQuerySchema = z.object({
  websiteId: z.uuid(),
  after: z.uuid().optional(),
  limit: z.int().min(1).max(50).default(20),
});

export type ListOrdersForBuyerQuery = z.input<typeof listOrdersForBuyerQuerySchema>;

/** The orders a buyer may see on a website, newest first. */
export async function listOrdersForBuyer(
  db: Database,
  buyerUserId: string,
  query: ListOrdersForBuyerQuery,
): Promise<OrderPage> {
  const q = listOrdersForBuyerQuerySchema.parse(query);
  const scope = await buyerOrders(db, buyerUserId);
  return page(db, [scope, eq(orders.websiteId, q.websiteId)], q.after, q.limit);
}

/** One order by number, if the buyer may see it on that website. */
export async function findOrderForBuyer(
  db: Database,
  buyerUserId: string,
  input: { websiteId: string; number: string },
): Promise<Order | undefined> {
  const number = z.string().max(40).safeParse(input.number);
  if (!number.success) return undefined;
  const scope = await buyerOrders(db, buyerUserId);
  const [row] = await db
    .select()
    .from(orders)
    .where(
      and(
        scope,
        eq(orders.websiteId, idSchema.parse(input.websiteId)),
        eq(orders.number, number.data.toUpperCase()),
      ),
    )
    .limit(1);
  return row ? withDetails(db, row) : undefined;
}

/** The orders with these ids that exist, keyed by id; for reports and links. */
export async function findOrderSummaries(
  db: Database,
  orderIds: readonly string[],
): Promise<Map<string, OrderSummary>> {
  const ids = z.array(idSchema).max(500).parse(orderIds);
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(orders).where(inArray(orders.id, ids));
  return new Map(rows.map((r) => [r.id, toSummary(r)]));
}

/** The order's workflow history, oldest first, for admins. */
export async function orderHistory(db: Database, orderId: string): Promise<TransitionLogEntry[]> {
  const order = await findOrderById(db, orderId);
  if (!order) throw new OrderError('order_not_found', 'No order with that id');
  return listTransitionLog(db, orderWorkflow, order.id);
}

export type TransitionOrderResult =
  { ok: true; order: Order } | { ok: false; refusal: TransitionRefusal };

/**
 * Moves an order through its workflow as an admin with order.manage (the admin API checks the
 * permission). `expectedVersion` refuses the move when the order changed since the admin looked.
 */
export async function transitionOrder(
  db: Database,
  input: {
    orderId: string;
    transition: OrderTransition;
    actor: Actor;
    now: Date;
    note?: string;
    expectedVersion?: number;
  },
): Promise<TransitionOrderResult> {
  const order = await findOrderById(db, input.orderId);
  if (!order) throw new OrderError('order_not_found', 'No order with that id');
  const result = await performTransition(db, orderWorkflow, {
    subjectId: order.id,
    transition: input.transition,
    context: {},
    actor: input.actor,
    now: input.now,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
  });
  if (!result.ok) return result;
  const updated = await findOrderById(db, order.id);
  if (!updated) throw new Error(`Order ${order.id} vanished`);
  return { ok: true, order: updated };
}
