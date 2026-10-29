export type PricingErrorCode =
  /** No price list with that id. */
  | 'price_list_not_found'
  /** A price list's active until date must be after its active from date. */
  | 'active_dates_out_of_order'
  /** No price with that id. */
  | 'price_not_found'
  /** The price list already has a price for that product, product unit and minimum quantity. */
  | 'price_tier_taken'
  /** The amount is not a valid amount in the price list's currency. */
  | 'invalid_amount'
  /** The quantity is not valid in the product unit. */
  | 'invalid_quantity'
  /** No product with that id. */
  | 'product_not_found'
  /** The product is not sold in that product unit. */
  | 'product_unit_not_sold'
  /** No assignment with that id. */
  | 'assignment_not_found'
  /** The price list is already assigned to that target on that website. */
  | 'assignment_taken'
  /** Another price list already has that priority for that target on that website. */
  | 'assignment_priority_taken'
  /** The price list's currency is not the website's currency. */
  | 'currency_mismatch'
  /** No website with that id. */
  | 'website_not_found'
  /** No customer with that id. */
  | 'customer_not_found'
  /** No customer group with that id. */
  | 'customer_group_not_found';

/** A refused pricing change or lookup. `code` is stable and safe to show to the caller. */
export class PricingError extends Error {
  readonly code: PricingErrorCode;

  constructor(code: PricingErrorCode, message: string) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
  }
}

/** Reads a field of the driver's error. postgres.js sets it; drizzle may wrap it in `cause`. */
function driverField(error: unknown, field: 'code' | 'constraint_name'): string | undefined {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const e of candidates) {
    const value =
      typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[field] : undefined;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** The name of the constraint a database error violated, if any. */
export function violatedConstraint(error: unknown): string | undefined {
  return driverField(error, 'constraint_name');
}

export function isUniqueViolation(error: unknown): boolean {
  return driverField(error, 'code') === '23505';
}

export function isCheckViolation(error: unknown): boolean {
  return driverField(error, 'code') === '23514';
}
