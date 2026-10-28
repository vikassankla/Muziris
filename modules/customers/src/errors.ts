export type CustomerErrorCode =
  /** No customer with that id. */
  | 'customer_not_found'
  /** No customer group with that id. */
  | 'customer_group_not_found'
  /** Another customer group already uses that code. */
  | 'customer_group_code_taken'
  /** The parent would be the customer itself or one of its subsidiaries. */
  | 'hierarchy_cycle'
  /** The identity user is not a buyer, or does not exist. */
  | 'not_a_buyer'
  /** The identity user is already a buyer user of a customer. */
  | 'buyer_user_exists'
  /** No invitation matches the token or id. */
  | 'invitation_not_found'
  /** The invitation's expiry has passed. */
  | 'invitation_expired'
  /** The invitation was already accepted or was revoked. */
  | 'invitation_closed'
  /** Another default billing or shipping address was set at the same moment. */
  | 'default_address_conflict';

/** A refused customers change. `code` is stable and safe to show to the caller. */
export class CustomerError extends Error {
  readonly code: CustomerErrorCode;

  constructor(code: CustomerErrorCode, message: string) {
    super(message);
    this.name = 'CustomerError';
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

function sqlState(error: unknown): string | undefined {
  return driverField(error, 'code');
}

/** The name of the constraint a database error violated, if any. */
export function violatedConstraint(error: unknown): string | undefined {
  return driverField(error, 'constraint_name');
}

export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === '23505';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return sqlState(error) === '23503';
}
