/** Why an admin read or change of an order was refused. */
export type OrderErrorCode =
  /** No order with that id or number. */
  'order_not_found';

/** A refused admin order request. `code` is stable and safe to show to the caller. */
export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode, message: string) {
    super(message);
    this.name = 'OrderError';
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

/** True when the error is the unique key on buyer and idempotency key. */
export function isIdempotencyConflict(error: unknown): boolean {
  return (
    driverField(error, 'code') === '23505' &&
    driverField(error, 'constraint_name') === 'orders_order_idempotency_uq'
  );
}
