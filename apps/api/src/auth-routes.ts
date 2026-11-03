import { createHash } from 'node:crypto';
import { grantBuyerRoleOnAcceptance } from '@muziris/access';
import {
  acceptInvitation,
  CustomerError,
  findCustomer,
  findPendingInvitation,
} from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  consumeRateLimit,
  EmailTakenError,
  PasswordPolicyError,
  revokeSession,
  SESSION_POLICIES,
  signIn,
  validateSession,
  type AuthenticatedUser,
  type Realm,
} from '@muziris/identity';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface AuthRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  clientIp: (c: Context) => string | undefined;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

export interface AuthVariables {
  requestId: string;
  user: AuthenticatedUser;
  sessionId: string;
}

/** Cookie names carry the __Host- prefix: Secure, Path=/, no Domain, so subdomains cannot set them. */
const COOKIE_NAMES: Record<Realm, string> = {
  admin: 'muziris_admin_session',
  buyer: 'muziris_buyer_session',
};

/** Admin cookies are Strict; buyer cookies are Lax so links in order emails keep the buyer signed in. */
const SAME_SITE: Record<Realm, 'Strict' | 'Lax'> = { admin: 'Strict', buyer: 'Lax' };

const SIGN_IN_LIMITS = {
  perIp: { limit: 20, windowMs: 10 * 60_000 },
  perEmail: { limit: 10, windowMs: 10 * 60_000 },
} as const;

/** Per IP, and per token, for looking up and accepting invitations (ADR 0020). */
const INVITATION_LIMITS = {
  perIp: { limit: 30, windowMs: 10 * 60_000 },
  perToken: { limit: 10, windowMs: 10 * 60_000 },
} as const;

/** What a token looks like is checked by the module; this only bounds the size. */
const tokenField = z.string().min(1).max(128);
const invitationBody = z.object({ token: tokenField });
const acceptBody = z.object({
  token: tokenField,
  password: z.string().min(1).max(1024),
  displayName: z.string().trim().min(1).max(200).optional(),
});

const INVITATION_PROBLEMS: Partial<Record<string, [401 | 404 | 409 | 410, string]>> = {
  invitation_not_found: [404, 'This invitation link is not valid'],
  invitation_expired: [410, 'This invitation has expired. Ask for a new one.'],
  invitation_closed: [409, 'This invitation was already used or withdrawn'],
};

const signInBody = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
});

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readSessionCookie(c: Context, realm: Realm): string | undefined {
  return getCookie(c, COOKIE_NAMES[realm], 'host');
}

/**
 * Cross-site request forgery guard. Browsers always send Origin on cross-origin POSTs, so a
 * state-changing request that carries cookies must come from an allowed origin. Requests with
 * no Origin are only accepted when Sec-Fetch-Site says they came from the same origin.
 */
export function trustedOriginGuard(trustedOrigins: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const fetchSite = c.req.header('sec-fetch-site');
      const allowed = origin ? trustedOrigins.has(origin) : fetchSite === 'same-origin';
      if (!allowed) {
        throw new HttpProblem(
          403,
          'untrusted_origin',
          'This request did not come from a trusted site',
        );
      }
    }
    await next();
  };
}

/** Requires a live session in the given realm and exposes the user to later handlers. */
export function requireSession(
  realm: Realm,
  deps: Pick<AuthRouteDependencies, 'db' | 'now'>,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = readSessionCookie(c, realm);
    const session = token ? await validateSession(deps.db, token, realm, deps.now()) : undefined;
    if (!session) {
      throw new HttpProblem(401, 'not_signed_in', 'Sign in to continue');
    }
    c.set('user', session.user);
    c.set('sessionId', session.sessionId);
    await next();
  };
}

function hashForKey(value: string): string {
  // Rate-limit keys never hold raw emails, so the counter table holds no personal data.
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 32);
}

async function enforceSignInLimits(
  c: Context,
  deps: AuthRouteDependencies,
  realm: Realm,
  email: string,
): Promise<void> {
  const now = deps.now();
  const ip = deps.clientIp(c) ?? 'unknown';
  const checks = [
    { key: `signin:${realm}:ip:${ip}`, ...SIGN_IN_LIMITS.perIp },
    { key: `signin:${realm}:email:${hashForKey(email)}`, ...SIGN_IN_LIMITS.perEmail },
  ];
  for (const check of checks) {
    const result = await consumeRateLimit(deps.db, check.key, check.limit, check.windowMs, now);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      deps.logger.warn(
        { requestId: c.get('requestId'), realm, limit: check.key.split(':')[2] },
        'auth.sign_in_rate_limited',
      );
      throw new HttpProblem(
        429,
        'too_many_attempts',
        'Too many sign-in attempts. Try again later.',
      );
    }
  }
}

async function enforceInvitationLimits(
  c: Context,
  deps: AuthRouteDependencies,
  token: string,
): Promise<void> {
  const now = deps.now();
  const ip = deps.clientIp(c) ?? 'unknown';
  const checks = [
    { key: `invitation:ip:${ip}`, ...INVITATION_LIMITS.perIp },
    // The key holds a hash of the token, never the token.
    { key: `invitation:token:${hashForKey(token)}`, ...INVITATION_LIMITS.perToken },
  ];
  for (const check of checks) {
    const result = await consumeRateLimit(deps.db, check.key, check.limit, check.windowMs, now);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      deps.logger.warn(
        { requestId: c.get('requestId'), limit: check.key.split(':')[1] },
        'auth.invitation_rate_limited',
      );
      throw new HttpProblem(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    }
  }
}

/** Turns an invitation refusal into its problem; anything else passes through. */
function invitationProblem(error: unknown): unknown {
  if (error instanceof CustomerError) {
    const known = INVITATION_PROBLEMS[error.code];
    if (known) return new HttpProblem(known[0], error.code, known[1]);
  }
  if (error instanceof EmailTakenError) {
    return new HttpProblem(
      409,
      'email_taken',
      'An account with this email already exists. Sign in instead.',
    );
  }
  if (error instanceof PasswordPolicyError) {
    return new HttpProblem(
      400,
      'password_policy',
      'The password does not meet the password policy',
      error.problems.join(', '),
    );
  }
  return error;
}

/** Sign-in, sign-out and current-user routes for one realm, mounted under its API prefix. */
export function authRoutes(
  realm: Realm,
  deps: AuthRouteDependencies,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', async (c, next) => {
    // Responses about sessions must never be cached by browsers or proxies.
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));

  /** Drops any session this browser already had, then sets the new one's cookie. */
  async function startSession(c: Context, token: string) {
    const previous = readSessionCookie(c, realm);
    if (previous) await revokeSession(deps.db, previous, deps.now());
    setCookie(c, COOKIE_NAMES[realm], token, {
      prefix: 'host',
      httpOnly: true,
      secure: true,
      sameSite: SAME_SITE[realm],
      path: '/',
      maxAge: Math.floor(SESSION_POLICIES[realm].absoluteTimeoutMs / 1000),
    });
  }

  app.post('/sign-in', async (c) => {
    const body = signInBody.parse(await c.req.json().catch(() => ({})));
    await enforceSignInLimits(c, deps, realm, body.email);

    const result = await signIn(deps.db, {
      realm,
      email: body.email,
      password: body.password,
      ipAddress: deps.clientIp(c),
      userAgent: c.req.header('user-agent'),
      now: deps.now(),
    });

    if (!result.ok) {
      deps.logger.info(
        { requestId: c.get('requestId'), realm, reason: result.reason, userId: result.userId },
        'auth.sign_in_failed',
      );
      // One message for every failure, so responses never confirm that an account exists.
      throw new HttpProblem(
        401,
        'invalid_credentials',
        'Email or password is incorrect',
        'Email or password is incorrect, or the account is temporarily locked. Try again in a few minutes.',
      );
    }

    await startSession(c, result.token);
    deps.logger.info(
      { requestId: c.get('requestId'), realm, userId: result.user.id },
      'auth.signed_in',
    );
    return c.json({ user: result.user, expiresAt: result.expiresAt.toISOString() });
  });

  app.post('/sign-out', async (c) => {
    const token = readSessionCookie(c, realm);
    if (token) await revokeSession(deps.db, token, deps.now());
    deleteCookie(c, COOKIE_NAMES[realm], { prefix: 'host', path: '/', secure: true });
    return c.body(null, 204);
  });

  app.get('/me', requireSession(realm, deps), (c) => c.json({ user: c.get('user') }));

  if (realm === 'buyer') {
    // Accepting an invitation (ADR 0020). The token travels in the body only: never in a URL
    // or a log. Both routes answer the same way for unknown and malformed tokens.

    /** Who the invitation is for, to show on the accept page. */
    app.post('/invitation', async (c) => {
      const { token } = invitationBody.parse(await c.req.json().catch(() => ({})));
      await enforceInvitationLimits(c, deps, token);
      try {
        const invitation = await findPendingInvitation(deps.db, token, deps.now());
        const customer = await findCustomer(deps.db, invitation.customerId);
        return c.json({
          invitation: {
            email: invitation.email,
            displayName: invitation.displayName,
            customerName: customer?.name ?? null,
            expiresAt: invitation.expiresAt.toISOString(),
          },
        });
      } catch (error) {
        throw invitationProblem(error);
      }
    });

    /** Creates the buyer's account from the invitation and signs them in. */
    app.post('/accept-invitation', async (c) => {
      const body = acceptBody.parse(await c.req.json().catch(() => ({})));
      await enforceInvitationLimits(c, deps, body.token);
      const now = deps.now();
      let buyer;
      let email;
      try {
        ({ email } = await findPendingInvitation(deps.db, body.token, now));
        buyer = await acceptInvitation(
          deps.db,
          {
            token: body.token,
            password: body.password,
            now,
            ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          },
          {
            // The invitation's buyer role (ADR 0021), in the transaction that links the buyer.
            inTransaction: async (tx, { buyerUser, invitation }) => {
              if (invitation.buyerRoleId === null) return;
              const granted = await grantBuyerRoleOnAcceptance(
                tx,
                buyerUser.userId,
                invitation.buyerRoleId,
              );
              if (!granted) {
                deps.logger.warn(
                  { requestId: c.get('requestId'), invitationId: invitation.id },
                  'auth.invitation_role_missing',
                );
              }
            },
          },
        );
      } catch (error) {
        throw invitationProblem(error);
      }
      deps.logger.info(
        { requestId: c.get('requestId'), userId: buyer.userId, customerId: buyer.customerId },
        'auth.invitation_accepted',
      );
      const signedIn = await signIn(deps.db, {
        realm,
        email,
        password: body.password,
        ipAddress: deps.clientIp(c),
        userAgent: c.req.header('user-agent'),
        now,
      });
      if (!signedIn.ok) {
        // The account exists; the buyer can sign in on the sign-in page.
        return c.json({ user: null }, 201);
      }
      await startSession(c, signedIn.token);
      return c.json({ user: signedIn.user, expiresAt: signedIn.expiresAt.toISOString() }, 201);
    });
  }

  return app;
}
