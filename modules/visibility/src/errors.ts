export type VisibilityErrorCode =
  /** No rule with that id. */
  | 'rule_not_found'
  /** The subject already has a rule for that target on that website; change it instead. */
  | 'rule_taken'
  /** No product with that id. */
  | 'product_not_found'
  /** No category with that id. */
  | 'category_not_found'
  /** No website with that id. */
  | 'website_not_found'
  /** No customer with that id. */
  | 'customer_not_found'
  /** No customer group with that id. */
  | 'customer_group_not_found';

/** A refused visibility change or read. `code` is stable and safe to show to the caller. */
export class VisibilityError extends Error {
  readonly code: VisibilityErrorCode;

  constructor(code: VisibilityErrorCode, message: string) {
    super(message);
    this.name = 'VisibilityError';
    this.code = code;
  }
}

/** Reads a field of the driver's error. postgres.js sets it; drizzle may wrap it in `cause`. */
function driverField(error: unknown, field: 'code'): string | undefined {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const e of candidates) {
    const value =
      typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[field] : undefined;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return driverField(error, 'code') === '23505';
}
