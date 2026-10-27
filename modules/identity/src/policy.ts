import type { Realm } from './types.js';

export interface SessionPolicy {
  /** Sign the user out after this long without a request. */
  idleTimeoutMs: number;
  /** Sign the user out this long after sign-in, however active they are. */
  absoluteTimeoutMs: number;
}

export interface LockoutPolicy {
  /** Failed attempts allowed before the account locks. */
  maxFailedAttempts: number;
  /** First lock length; each further failure doubles it, up to maxLockMs. */
  baseLockMs: number;
  maxLockMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Admin sessions are short because admins can change prices and permissions.
 * Buyer sessions are longer because B2B buyers reorder from the same device for weeks.
 */
export const SESSION_POLICIES: Record<Realm, SessionPolicy> = {
  admin: { idleTimeoutMs: 30 * MINUTE, absoluteTimeoutMs: 12 * HOUR },
  buyer: { idleTimeoutMs: 3 * DAY, absoluteTimeoutMs: 30 * DAY },
};

export const LOCKOUT_POLICY: LockoutPolicy = {
  maxFailedAttempts: 5,
  baseLockMs: MINUTE,
  maxLockMs: 15 * MINUTE,
};

/** Only refresh last_seen_at when it is this stale, to avoid a write on every request. */
export const LAST_SEEN_REFRESH_MS = MINUTE;

/** Lock length after the given number of consecutive failures, or 0 if not locked. */
export function lockDurationMs(
  failedCount: number,
  policy: LockoutPolicy = LOCKOUT_POLICY,
): number {
  if (failedCount < policy.maxFailedAttempts) return 0;
  const doublings = Math.min(failedCount - policy.maxFailedAttempts, 20);
  return Math.min(policy.baseLockMs * 2 ** doublings, policy.maxLockMs);
}
