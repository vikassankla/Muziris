export type CatalogErrorCode =
  /** No product with that id. */
  | 'product_not_found'
  /** Another product already uses that SKU, in any letter case. */
  | 'sku_taken'
  /** No product unit with that code. */
  | 'product_unit_not_found'
  /** Another product unit already uses that code. */
  | 'product_unit_code_taken'
  /** No category with that id. */
  | 'category_not_found'
  /** Another category already uses that code. */
  | 'category_code_taken'
  /** The parent would be the category itself or one of its subcategories. */
  | 'category_cycle'
  /** The category still has subcategories or products. */
  | 'category_not_empty';

/** A refused catalog change. `code` is stable and safe to show to the caller. */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = 'CatalogError';
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

export function isForeignKeyViolation(error: unknown): boolean {
  return driverField(error, 'code') === '23503';
}

/** Deleting a row that an `on delete restrict` foreign key still refers to. */
export function isRestrictViolation(error: unknown): boolean {
  return driverField(error, 'code') === '23001';
}
