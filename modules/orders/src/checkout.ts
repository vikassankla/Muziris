import { createHash } from 'node:crypto';
import { getBuyerAccess } from '@muziris/access';
import {
  findProductsWithin,
  parseQuantity,
  quantityToString,
  type Product,
} from '@muziris/catalog';
import {
  findBuyerUser,
  findCustomerForBuyer,
  listAddressesForBuyer,
  type Address,
  type BuyerViewer,
} from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  compare,
  isCurrencyCode,
  moneyFromDecimal,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import { findWebsite, getSetting, type Website } from '@muziris/platform';
import { findPricesForBuyer, MAX_PRICE_ITEMS } from '@muziris/pricing';
import { visibleProductIdsForBuyer } from '@muziris/visibility';
import { startWorkflow } from '@muziris/workflow';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { orderAddresses, orderLines, orders, orderTaxLines } from './db/schema.js';
import { isIdempotencyConflict } from './errors.js';
import { findOrderById, type Order } from './read.js';
import { ORDER_NUMBER_PREFIX, PAYMENT_TERM_DAYS, SHIPPING_FLAT_RATE } from './settings.js';
import {
  computeTotals,
  flatRateShipping,
  noLineDiscounts,
  noOrderDiscounts,
  noShippingDiscounts,
  type PricedLine,
  type TaxAddress,
  type TaxProvider,
  type Totals,
  type TotalsProviders,
} from './totals.js';
import { orderWorkflow } from './workflow.js';

// Checkout (ADR 0016) is a function, not a stored record: it takes lines and the buyer's
// choices and computes the totals. previewCheckout shows them; placeOrder computes them again
// and stores the order. Where the lines come from (quick order, a shopping list, a quote) is the
// caller's business.

const lineSchema = z.object({
  productId: z.uuid(),
  unitCode: z.string().min(1).max(64),
  /** A decimal string in the product unit's precision, such as "12" or "2.500". */
  quantity: z.string().trim().min(1).max(40),
});

export const checkoutRequestSchema = z.object({
  websiteId: z.uuid(),
  lines: z.array(lineSchema).min(1).max(MAX_PRICE_ITEMS),
  billingAddressId: z.uuid(),
  shippingAddressId: z.uuid(),
  purchaseOrderNumber: z.string().trim().min(1).max(64).optional(),
});

export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;

export const placeOrderRequestSchema = checkoutRequestSchema.extend({
  /** A fresh UUID per attempt; repeating it returns the same order. */
  idempotencyKey: z.uuid(),
  /** The grand total the buyer saw, in major units ("1250.50"). */
  expectedGrandTotal: z
    .string()
    .trim()
    .regex(/^\d{1,15}(\.\d{1,6})?$/),
});

export type PlaceOrderRequest = z.input<typeof placeOrderRequestSchema>;

/** What a checkout needs besides the database: the tax provider, and other stages to replace. */
export interface CheckoutDependencies {
  tax: TaxProvider;
  lineDiscounts?: TotalsProviders['lineDiscounts'];
  orderDiscounts?: TotalsProviders['orderDiscounts'];
  shippingDiscounts?: TotalsProviders['shippingDiscounts'];
}

export type LineProblemCode =
  /** Not a product the buyer can order: unknown, disabled or not visible to them. */
  | 'product_not_available'
  /** The product is not sold in that unit. */
  | 'unit_not_sold'
  /** The quantity does not fit the unit's precision, or is not above zero. */
  | 'invalid_quantity'
  /** No price for the buyer at that unit and quantity, including below the lowest tier. */
  | 'no_price';

export interface LineProblem {
  lineNo: number;
  code: LineProblemCode;
  message: string;
}

/** Why a checkout cannot go on. Each is safe to show to the buyer. */
export type CheckoutRefusal =
  /** Not a buyer user, or no order.place permission. */
  | { code: 'not_allowed' }
  /** No such website, or it is switched off. */
  | { code: 'website_not_found' }
  /** The address is not one of the buyer's customer's addresses. */
  | { code: 'address_not_found'; role: 'billing' | 'shipping' }
  | { code: 'line_problems'; lines: LineProblem[] }
  /** The total changed since the buyer saw it; they should review the new totals. */
  | { code: 'prices_changed'; expected: Money; totals: Totals }
  /** The idempotency key was used before for a different order. */
  | { code: 'idempotency_key_reused' };

export interface CheckoutPreview {
  totals: Totals;
  paymentTermDays: number;
  /** The day payment would be due if placed now, in the website's time zone. */
  dueOn: string;
}

export type CheckoutResult =
  { ok: true; preview: CheckoutPreview } | { ok: false; refusal: CheckoutRefusal };

export type PlaceOrderResult =
  { ok: true; order: Order; replayed: boolean } | { ok: false; refusal: CheckoutRefusal };

/** The calendar day `days` after `now`, in a time zone, as YYYY-MM-DD. */
export function dueDate(now: Date, timeZone: string, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year, month, day] = today.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Unexpected date format: ${today}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function taxAddress(address: Address): TaxAddress {
  return {
    countryCode: address.countryCode,
    regionCode: address.regionCode,
    postalCode: address.postalCode,
    gstin: address.gstin,
  };
}

interface Prepared {
  website: Website;
  currency: CurrencyCode;
  customer: { id: string; name: string };
  billing: Address;
  shipping: Address;
  totals: Totals;
  paymentTermDays: number;
  dueOn: string;
}

type Prepare = { ok: true; prepared: Prepared } | { ok: false; refusal: CheckoutRefusal };

/** Loads and checks everything a checkout needs, then runs the totals pipeline. */
async function prepare(
  db: Database,
  buyerUserId: string,
  request: z.output<typeof checkoutRequestSchema>,
  deps: CheckoutDependencies,
  now: Date,
): Promise<Prepare> {
  const refuse = (refusal: CheckoutRefusal): Prepare => ({ ok: false, refusal });

  const buyer = await findBuyerUser(db, buyerUserId);
  if (!buyer) return refuse({ code: 'not_allowed' });
  const access = await getBuyerAccess(db, buyerUserId);
  if (access.get('order.place') === undefined) return refuse({ code: 'not_allowed' });

  const website = await findWebsite(db, request.websiteId);
  if (!website?.isActive) return refuse({ code: 'website_not_found' });
  const currency = website.defaultCurrency;
  if (!isCurrencyCode(currency)) throw new Error(`Website ${website.code} has no known currency`);

  // The buyer orders for their own customer; its addresses only.
  const viewer: BuyerViewer = { buyerUserId, reach: 'my_customer' };
  const customer = await findCustomerForBuyer(db, viewer, buyer.customerId);
  if (!customer) return refuse({ code: 'not_allowed' });
  const addresses = await listAddressesForBuyer(db, viewer, customer.id);
  const billing = addresses.find((a) => a.id === request.billingAddressId);
  if (!billing) return refuse({ code: 'address_not_found', role: 'billing' });
  const shipping = addresses.find((a) => a.id === request.shippingAddressId);
  if (!shipping) return refuse({ code: 'address_not_found', role: 'shipping' });

  // Products the buyer may see now, enabled ones only (visibility leaves out disabled ones).
  const ids = [...new Set(request.lines.map((l) => l.productId))];
  const found = await findProductsWithin(
    db,
    visibleProductIdsForBuyer({ buyerUserId, websiteId: website.id }),
    ids,
  );
  const products = new Map<string, Product>(
    found.filter((p) => p.status === 'enabled').map((p) => [p.id, p]),
  );

  const problems: LineProblem[] = [];
  const checked: {
    lineNo: number;
    product: Product;
    unitName: string;
    unitCode: string;
    quantity: Decimal;
  }[] = [];
  request.lines.forEach((line, index) => {
    const lineNo = index + 1;
    const product = products.get(line.productId);
    if (!product) {
      problems.push({
        lineNo,
        code: 'product_not_available',
        message: 'This product cannot be ordered',
      });
      return;
    }
    const unit = product.units.find((u) => u.code === line.unitCode);
    if (!unit) {
      problems.push({
        lineNo,
        code: 'unit_not_sold',
        message: `${product.sku} is not sold in that unit`,
      });
      return;
    }
    try {
      const quantity = parseQuantity(line.quantity, unit);
      checked.push({ lineNo, product, unitCode: unit.code, unitName: unit.name, quantity });
    } catch (error) {
      problems.push({
        lineNo,
        code: 'invalid_quantity',
        message: error instanceof RangeError ? error.message : 'Not a valid quantity',
      });
    }
  });

  const prices = await findPricesForBuyer(db, {
    buyerUserId,
    websiteId: website.id,
    currency,
    now,
    items: checked.map((c) => ({
      productId: c.product.id,
      unitCode: c.unitCode,
      quantity: c.quantity,
    })),
  });
  const priced: PricedLine[] = [];
  checked.forEach((c, index) => {
    const price = prices[index];
    if (price?.found !== true) {
      problems.push({
        lineNo: c.lineNo,
        code: 'no_price',
        message: `There is no price for ${c.product.sku} at that quantity on your account`,
      });
      return;
    }
    priced.push({
      lineNo: c.lineNo,
      productId: c.product.id,
      sku: c.product.sku,
      productName: c.product.name,
      unitCode: c.unitCode,
      unitName: c.unitName,
      quantity: c.quantity,
      unitPrice: price.unitPrice,
      priceListId: price.priceListId,
    });
  });
  if (problems.length > 0) {
    return refuse({ code: 'line_problems', lines: problems.sort((a, b) => a.lineNo - b.lineNo) });
  }

  const scope = {
    customerId: customer.id,
    ...(customer.groupId === null ? {} : { customerGroupId: customer.groupId }),
    websiteId: website.id,
    organizationId: website.organizationId,
  };
  const [term, rate] = await Promise.all([
    getSetting(db, PAYMENT_TERM_DAYS, scope),
    getSetting(db, SHIPPING_FLAT_RATE, scope),
  ]);
  const totals = await computeTotals(
    priced,
    {
      websiteId: website.id,
      customerId: customer.id,
      currency,
      billTo: taxAddress(billing),
      shipTo: taxAddress(shipping),
      now,
    },
    {
      lineDiscounts: deps.lineDiscounts ?? noLineDiscounts,
      orderDiscounts: deps.orderDiscounts ?? noOrderDiscounts,
      // The flat rate is rounded half up to the currency's minor unit, once, here.
      shipping: flatRateShipping(moneyFromDecimal(rate.value.amount, currency, 'half-up')),
      shippingDiscounts: deps.shippingDiscounts ?? noShippingDiscounts,
      tax: deps.tax,
    },
  );
  return {
    ok: true,
    prepared: {
      website,
      currency,
      customer: { id: customer.id, name: customer.name },
      billing,
      shipping,
      totals,
      paymentTermDays: term.value,
      dueOn: dueDate(now, website.timeZone, term.value),
    },
  };
}

/** The totals a buyer would get for these lines now, without saving anything. */
export async function previewCheckout(
  db: Database,
  input: { buyerUserId: string; request: CheckoutRequest; now: Date },
  deps: CheckoutDependencies,
): Promise<CheckoutResult> {
  const request = checkoutRequestSchema.parse(input.request);
  const result = await prepare(db, z.uuid().parse(input.buyerUserId), request, deps, input.now);
  if (!result.ok) return result;
  const { totals, paymentTermDays, dueOn } = result.prepared;
  return { ok: true, preview: { totals, paymentTermDays, dueOn } };
}

/** SHA-256 of what makes two attempts the same order. */
function requestHash(request: z.output<typeof placeOrderRequestSchema>): string {
  const canonical = JSON.stringify([
    request.websiteId,
    request.lines.map((l) => [l.productId, l.unitCode, l.quantity]),
    request.billingAddressId,
    request.shippingAddressId,
    request.purchaseOrderNumber ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The order this buyer placed with this key, if any, checked against the request. */
async function replay(
  db: Database,
  buyerUserId: string,
  key: string,
  hash: string,
): Promise<PlaceOrderResult | undefined> {
  const [row] = await db
    .select({ id: orders.id, requestHash: orders.requestHash })
    .from(orders)
    .where(sql`${orders.placedBy} = ${buyerUserId} and ${orders.idempotencyKey} = ${key}`)
    .limit(1);
  if (!row) return undefined;
  if (row.requestHash !== hash) return { ok: false, refusal: { code: 'idempotency_key_reused' } };
  const order = await findOrderById(db, row.id);
  if (!order) throw new Error(`Order ${row.id} vanished`);
  return { ok: true, order, replayed: true };
}

/**
 * Places an order (FR-CO-3): checks the buyer, the addresses, every product, unit, quantity and
 * price again, refuses when the grand total is not the one the buyer saw, then stores the order
 * and starts its workflow in one transaction. Repeating an idempotency key returns the first
 * order, even when two attempts race.
 */
export async function placeOrder(
  db: Database,
  input: { buyerUserId: string; request: PlaceOrderRequest; now: Date },
  deps: CheckoutDependencies,
): Promise<PlaceOrderResult> {
  const request = placeOrderRequestSchema.parse(input.request);
  const buyerUserId = z.uuid().parse(input.buyerUserId);
  const hash = requestHash(request);

  const earlier = await replay(db, buyerUserId, request.idempotencyKey, hash);
  if (earlier) return earlier;

  const result = await prepare(db, buyerUserId, request, deps, input.now);
  if (!result.ok) return result;
  const p = result.prepared;
  const expected = moneyFromDecimal(request.expectedGrandTotal, p.currency, 'half-up');
  if (compare(expected, p.totals.grandTotal) !== 0) {
    return { ok: false, refusal: { code: 'prices_changed', expected, totals: p.totals } };
  }

  const scope = { websiteId: p.website.id, organizationId: p.website.organizationId };
  const prefix = (await getSetting(db, ORDER_NUMBER_PREFIX, scope)).value;
  const t = p.totals;

  let orderId: string;
  try {
    orderId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(orders)
        .values({
          number: sql`${prefix} || '-' || lpad(nextval('orders_order_number_seq')::text, 6, '0')`,
          websiteId: p.website.id,
          customerId: p.customer.id,
          customerName: p.customer.name,
          placedBy: buyerUserId,
          idempotencyKey: request.idempotencyKey,
          requestHash: hash,
          currency: p.currency,
          purchaseOrderNumber: request.purchaseOrderNumber ?? null,
          paymentTermDays: p.paymentTermDays,
          dueOn: p.dueOn,
          shippingMethod: t.shippingMethod,
          taxProvider: t.taxProvider,
          subtotalMinor: t.subtotal.minor,
          discountMinor: t.discount.minor,
          shippingMinor: t.shipping.minor,
          shippingDiscountMinor: t.shippingDiscount.minor,
          taxMinor: t.tax.minor,
          grandTotalMinor: t.grandTotal.minor,
          placedAt: input.now,
        })
        .returning({ id: orders.id });
      if (!row) throw new Error('Order insert returned no row');
      await tx.insert(orderLines).values(
        t.lines.map((l) => ({
          orderId: row.id,
          lineNo: l.lineNo,
          productId: l.productId,
          sku: l.sku,
          productName: l.productName,
          unitCode: l.unitCode,
          unitName: l.unitName,
          quantity: quantityToString(l.quantity),
          unitPriceMinor: l.unitPrice.minor,
          subtotalMinor: l.subtotal.minor,
          discountMinor: l.discount.minor,
          netMinor: l.net.minor,
          taxCode: l.taxCode,
          priceListId: l.priceListId,
        })),
      );
      if (t.taxes.length > 0) {
        await tx.insert(orderTaxLines).values(
          t.taxes.map((x) => ({
            orderId: row.id,
            lineNo: x.lineNo,
            name: x.name,
            rate: x.rate,
            taxableMinor: x.taxable.minor,
            amountMinor: x.amount.minor,
          })),
        );
      }
      await tx.insert(orderAddresses).values(
        (
          [
            ['billing', p.billing],
            ['shipping', p.shipping],
          ] as const
        ).map(([role, a]) => ({
          orderId: row.id,
          role,
          addressId: a.id,
          label: a.label,
          countryCode: a.countryCode,
          line1: a.line1,
          line2: a.line2,
          city: a.city,
          regionCode: a.regionCode,
          postalCode: a.postalCode,
          gstin: a.gstin,
        })),
      );
      await startWorkflow(tx, orderWorkflow, {
        subjectId: row.id,
        actor: { type: 'buyer_user', id: buyerUserId },
        now: input.now,
      });
      return row.id;
    });
  } catch (error) {
    // Another attempt with the same key won the race; answer with its order.
    if (isIdempotencyConflict(error)) {
      const winner = await replay(db, buyerUserId, request.idempotencyKey, hash);
      if (winner) return winner;
    }
    throw error;
  }
  const order = await findOrderById(db, orderId);
  if (!order) throw new Error(`Order ${orderId} vanished`);
  return { ok: true, order, replayed: false };
}
