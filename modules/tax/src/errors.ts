/** Why an admin change to tax data was refused. */
export type TaxErrorCode =
  | 'website_not_found'
  | 'customer_not_found'
  | 'registration_not_found'
  /** The website already has a registration for that regime and state. */
  | 'registration_taken'
  /** The registration does not fit the website: GST for India, sales tax for the US. */
  | 'wrong_regime'
  | 'rate_not_found'
  /** Another rate for the same code, state or ZIP prefix applies on some of the same days. */
  | 'rate_overlaps'
  | 'exemption_not_found'
  /** The customer already has an exemption certificate for that state. */
  | 'exemption_taken'
  /** A CSV import has rows that are not valid; nothing was imported. */
  | 'invalid_import';

/** A refused admin tax request. `code` is stable and safe to show to the caller. */
export class TaxError extends Error {
  readonly code: TaxErrorCode;
  /** For invalid_import: each refused row, numbered from 1 after the header. */
  readonly rows: readonly { row: number; message: string }[];

  constructor(
    code: TaxErrorCode,
    message: string,
    rows: readonly { row: number; message: string }[] = [],
  ) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
    this.rows = rows;
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

/** True when the error is a unique violation of the named constraint. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    driverField(error, 'code') === '23505' && driverField(error, 'constraint_name') === constraint
  );
}
