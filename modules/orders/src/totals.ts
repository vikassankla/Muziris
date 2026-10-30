import {
  add,
  compare,
  sum,
  subtract,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import { lineAmount } from '@muziris/pricing';

// The totals pipeline (FR-CO-1, ADR 0016): line subtotals, line discounts, order discounts,
// shipping, shipping discounts, tax, grand total. Each stage after the subtotals is a provider,
// so a discount engine or a tax service can replace the pilot's without touching checkout.
// Every amount is Money in the order's currency; each stage rounds once, inside its provider,
// and this file only adds and checks.

/** A line as checkout priced it, before any discount or tax. */
export interface PricedLine {
  /** 1, 2, 3 … in the order the buyer listed them. */
  lineNo: number;
  productId: string;
  sku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  /** At the product unit's precision. */
  quantity: Decimal;
  unitPrice: Money;
  /** The price list the unit price came from. */
  priceListId: string;
}

/** A reduction with the reason a buyer sees, such as "Spring promotion". Never negative. */
export interface Adjustment {
  reason: string;
  amount: Money;
}

/** An address as tax sees it. */
export interface TaxAddress {
  countryCode: string;
  regionCode: string;
  postalCode: string;
  gstin: string | null;
}

export interface TotalsContext {
  websiteId: string;
  customerId: string;
  currency: CurrencyCode;
  billTo: TaxAddress;
  shipTo: TaxAddress;
  now: Date;
}

export interface LineDiscountProvider {
  readonly name: string;
  /** Discounts per line; a line may have several. Each must not exceed the line's subtotal. */
  lineDiscounts(
    lines: readonly (PricedLine & { subtotal: Money })[],
    context: TotalsContext,
  ): Promise<readonly { lineNo: number; adjustment: Adjustment }[]>;
}

export interface OrderDiscountProvider {
  readonly name: string;
  /** Discounts on the whole order, after line discounts. */
  orderDiscounts(linesNet: Money, context: TotalsContext): Promise<readonly Adjustment[]>;
}

export interface ShippingProvider {
  readonly name: string;
  quote(goods: Money, context: TotalsContext): Promise<{ method: string; amount: Money }>;
}

export interface ShippingDiscountProvider {
  readonly name: string;
  shippingDiscounts(shipping: Money, context: TotalsContext): Promise<readonly Adjustment[]>;
}

export interface TaxRequest extends TotalsContext {
  /** Each line's amount after its line discounts. */
  lines: readonly { lineNo: number; productId: string; net: Money }[];
  /** Order discounts, not spread over the lines; the provider decides how they reduce tax. */
  orderDiscount: Money;
  /** Shipping after shipping discounts. */
  shipping: Money;
}

/** One tax: on a line, or on shipping when `lineNo` is null. */
export interface TaxLine {
  lineNo: number | null;
  name: string;
  /** A decimal fraction as text, for example "0.09" for 9%. */
  rate: string;
  taxable: Money;
  amount: Money;
}

export interface TaxResult {
  lines: readonly TaxLine[];
  /** The tax code used for each line, where the provider has one. */
  taxCodes: ReadonlyMap<number, string>;
}

export interface TaxProvider {
  readonly name: string;
  calculate(request: TaxRequest): Promise<TaxResult>;
}

export interface TotalsProviders {
  lineDiscounts: LineDiscountProvider;
  orderDiscounts: OrderDiscountProvider;
  shipping: ShippingProvider;
  shippingDiscounts: ShippingDiscountProvider;
  tax: TaxProvider;
}

export interface TotalsLine extends PricedLine {
  subtotal: Money;
  discounts: readonly Adjustment[];
  discount: Money;
  net: Money;
  taxCode: string | null;
}

export interface Totals {
  currency: CurrencyCode;
  lines: readonly TotalsLine[];
  orderDiscounts: readonly Adjustment[];
  shippingMethod: string;
  shippingDiscounts: readonly Adjustment[];
  taxes: readonly TaxLine[];
  taxProvider: string;
  /** The sum of line subtotals. */
  subtotal: Money;
  /** Line discounts and order discounts together. */
  discount: Money;
  shipping: Money;
  shippingDiscount: Money;
  tax: Money;
  grandTotal: Money;
}

const ZERO_DISCOUNTS: readonly Adjustment[] = Object.freeze([]);

/** No line discounts: the pilot has no promotions. */
export const noLineDiscounts: LineDiscountProvider = {
  name: 'none',
  lineDiscounts: () => Promise.resolve([]),
};

/** No order discounts. */
export const noOrderDiscounts: OrderDiscountProvider = {
  name: 'none',
  orderDiscounts: () => Promise.resolve(ZERO_DISCOUNTS),
};

/** No shipping discounts. */
export const noShippingDiscounts: ShippingDiscountProvider = {
  name: 'none',
  shippingDiscounts: () => Promise.resolve(ZERO_DISCOUNTS),
};

/** One charge per order, whatever it holds (the pilot's flat-rate shipping). */
export function flatRateShipping(amount: Money): ShippingProvider {
  return {
    name: 'flat_rate',
    quote: () => Promise.resolve({ method: 'flat_rate', amount }),
  };
}

/** A provider broke its contract. That is a programming error, never the buyer's. */
class ProviderError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

function checkAdjustment(provider: string, adjustment: Adjustment, currency: CurrencyCode) {
  if (adjustment.amount.currency !== currency) {
    throw new ProviderError(provider, `an adjustment is in ${adjustment.amount.currency}`);
  }
  if (adjustment.amount.minor < 0n) {
    throw new ProviderError(provider, 'an adjustment is negative');
  }
}

/** Runs the totals pipeline over priced lines. Lines must be in the context's currency. */
export async function computeTotals(
  priced: readonly PricedLine[],
  context: TotalsContext,
  providers: TotalsProviders,
): Promise<Totals> {
  const { currency } = context;
  const lineNos = new Set<number>();
  for (const line of priced) {
    if (line.unitPrice.currency !== currency) {
      throw new TypeError(`Line ${line.lineNo} is priced in ${line.unitPrice.currency}`);
    }
    if (lineNos.has(line.lineNo)) throw new TypeError(`Line ${line.lineNo} appears twice`);
    lineNos.add(line.lineNo);
  }

  // 1. Line subtotals: unit price times quantity, rounded once half up (ADR 0011).
  const withSubtotals = priced.map((line) => ({
    ...line,
    subtotal: lineAmount(line.unitPrice, line.quantity),
  }));

  // 2. Line discounts.
  const lineDiscounts = await providers.lineDiscounts.lineDiscounts(withSubtotals, context);
  const discountsByLine = new Map<number, Adjustment[]>();
  for (const { lineNo, adjustment } of lineDiscounts) {
    checkAdjustment(providers.lineDiscounts.name, adjustment, currency);
    if (!lineNos.has(lineNo)) {
      throw new ProviderError(providers.lineDiscounts.name, `no line ${lineNo}`);
    }
    discountsByLine.set(lineNo, [...(discountsByLine.get(lineNo) ?? []), adjustment]);
  }
  const lines = withSubtotals.map((line) => {
    const discounts = discountsByLine.get(line.lineNo) ?? [];
    const discount = sum(
      discounts.map((d) => d.amount),
      currency,
    );
    if (compare(discount, line.subtotal) > 0) {
      throw new ProviderError(
        providers.lineDiscounts.name,
        `line ${line.lineNo} is discounted below zero`,
      );
    }
    return { ...line, discounts, discount, net: subtract(line.subtotal, discount) };
  });
  const subtotal = sum(
    lines.map((l) => l.subtotal),
    currency,
  );
  const linesNet = sum(
    lines.map((l) => l.net),
    currency,
  );

  // 3. Order discounts.
  const orderDiscounts = await providers.orderDiscounts.orderDiscounts(linesNet, context);
  for (const d of orderDiscounts) checkAdjustment(providers.orderDiscounts.name, d, currency);
  const orderDiscount = sum(
    orderDiscounts.map((d) => d.amount),
    currency,
  );
  if (compare(orderDiscount, linesNet) > 0) {
    throw new ProviderError(providers.orderDiscounts.name, 'the order is discounted below zero');
  }
  const goods = subtract(linesNet, orderDiscount);

  // 4. Shipping.
  const quote = await providers.shipping.quote(goods, context);
  checkAdjustment(providers.shipping.name, { reason: 'shipping', amount: quote.amount }, currency);

  // 5. Shipping discounts.
  const shippingDiscounts = await providers.shippingDiscounts.shippingDiscounts(
    quote.amount,
    context,
  );
  for (const d of shippingDiscounts) {
    checkAdjustment(providers.shippingDiscounts.name, d, currency);
  }
  const shippingDiscount = sum(
    shippingDiscounts.map((d) => d.amount),
    currency,
  );
  if (compare(shippingDiscount, quote.amount) > 0) {
    throw new ProviderError(providers.shippingDiscounts.name, 'shipping is discounted below zero');
  }
  const shippingNet = subtract(quote.amount, shippingDiscount);

  // 6. Tax.
  const tax = await providers.tax.calculate({
    ...context,
    lines: lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, net: l.net })),
    orderDiscount,
    shipping: shippingNet,
  });
  for (const t of tax.lines) {
    if (t.lineNo !== null && !lineNos.has(t.lineNo)) {
      throw new ProviderError(providers.tax.name, `a tax is on missing line ${t.lineNo}`);
    }
    for (const amount of [t.taxable, t.amount]) {
      checkAdjustment(providers.tax.name, { reason: t.name, amount }, currency);
    }
  }
  const taxTotal = sum(
    tax.lines.map((t) => t.amount),
    currency,
  );

  // 7. Grand total.
  const grandTotal = add(add(goods, shippingNet), taxTotal);

  return {
    currency,
    lines: lines.map((l) => ({ ...l, taxCode: tax.taxCodes.get(l.lineNo) ?? null })),
    orderDiscounts,
    shippingMethod: quote.method,
    shippingDiscounts,
    taxes: tax.lines,
    taxProvider: providers.tax.name,
    subtotal,
    discount: add(
      sum(
        lines.map((l) => l.discount),
        currency,
      ),
      orderDiscount,
    ),
    shipping: quote.amount,
    shippingDiscount,
    tax: taxTotal,
    grandTotal,
  };
}
