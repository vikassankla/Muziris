// Public interface of the identity module. Other modules import only from here.
export {
  deleteDeadSessions,
  revokeSession,
  signIn,
  validateSession,
  type SignInFailure,
  type SignInInput,
  type SignInResult,
  type ValidSession,
} from './auth.js';
export {
  checkPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordProblem,
} from './password.js';
export {
  LOCKOUT_POLICY,
  lockDurationMs,
  SESSION_POLICIES,
  type LockoutPolicy,
  type SessionPolicy,
} from './policy.js';
export { consumeRateLimit, pruneRateLimits, type RateLimitResult } from './rate-limit.js';
export { isWellFormedToken } from './tokens.js';
export type { AuthenticatedUser, Realm } from './types.js';
export {
  activeUserIds,
  changePassword,
  createUser,
  disableUser,
  EmailTakenError,
  findUserByEmail,
  findUserById,
  newUserSchema,
  PasswordPolicyError,
  type NewUser,
} from './users.js';
