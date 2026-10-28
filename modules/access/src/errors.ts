export type AccessControlErrorCode =
  /** No role with that id or code. */
  | 'role_not_found'
  /** No user with that id in the realm the role belongs to. */
  | 'user_not_found'
  /** Another role already uses that code. */
  | 'role_code_taken'
  /** Built-in roles cannot be edited or deleted. */
  | 'built_in_role'
  /** The actor tried to grant, or take away, permissions they do not hold themselves. */
  | 'privilege_escalation'
  /** The change would leave no admin user with the administrator role. */
  | 'last_administrator';

/** A refused access-control change. `code` is stable and safe to show to the caller. */
export class AccessControlError extends Error {
  readonly code: AccessControlErrorCode;

  constructor(code: AccessControlErrorCode, message: string) {
    super(message);
    this.name = 'AccessControlError';
    this.code = code;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  // postgres.js puts the SQLSTATE on `code`; drizzle may wrap it in `cause`.
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (e) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505',
  );
}
