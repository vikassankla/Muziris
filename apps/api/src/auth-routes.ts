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
  acceptUserInvitation,
  confirmEnrolment,
  confirmReplacement,
  consumeRateLimit,
  EmailTakenError,
  findPendingUserInvitation,
  IdentityError,
  PasswordPolicyError,
  replaceRecoveryCodes,
  revokeSession,
  SESSION_POLICIES,
  signIn,
  startEnrolment,
  startReplacement,
  TWO_FACTOR_STEP_MS,
  twoFactorStatus,
  validateSession,
  validateTwoFactorSession,
  verifySecondFactor,
  type AuthenticatedUser,
  type Realm,
  type TotpKey,
  type TwoFactorRefusal,
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
  /** ADMIN_TOTP_KEY (ADR 0026); without it admins cannot finish signing in. */
  twoFactorKey?: TotpKey | undefined;
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

/**
 * The two-factor session between the password and the code (ADR 0026): a cookie of its own,
 * with the same rules, that dies with the step.
 */
const TWO_FACTOR_COOKIE = 'muziris_admin_two_factor';

/** The name authenticator apps show beside the codes. */
const TOTP_ISSUER = 'Muziris';

/** Admin cookies are Strict; buyer cookies are Lax so links in order emails keep the buyer signed in. */
const SAME_SITE: Record<Realm, 'Strict' | 'Lax'> = { admin: 'Strict', buyer: 'Lax' };

const SIGN_IN_LIMITS = {
  perIp: { limit: 20, windowMs: 10 * 60_000 },
  perEmail: { limit: 10, windowMs: 10 * 60_000 },
} as const;

/** Per admin, for the code step and changes to the second factor (ADR 0026). */
const TWO_FACTOR_LIMIT = { limit: 10, windowMs: 10 * 60_000 } as const;

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

const codeField = z.string().trim().min(1).max(64);
const verifyBody = z.union([
  z.object({ code: codeField }).strict(),
  z.object({ recoveryCode: codeField }).strict(),
]);
const confirmBody = z.object({ code: codeField });
const changeBody = z.object({ password: z.string().min(1).max(1024), code: codeField });

/** One answer for a wrong code and a locked account, as for a wrong password (ADR 0026). */
function invalidCode(): HttpProblem {
  return new HttpProblem(
    401,
    'invalid_code',
    'The code is incorrect',
    'The code is incorrect, or the account is temporarily locked. Try again in a few minutes.',
  );
}

function twoFactorExpired(): HttpProblem {
  return new HttpProblem(401, 'two_factor_expired', 'Sign in again to continue');
}

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

/** Per IP, shared with sign-in, and per admin, for every code they enter. */
async function enforceTwoFactorLimits(
  c: Context,
  deps: AuthRouteDependencies,
  userId: string,
): Promise<void> {
  const now = deps.now();
  const ip = deps.clientIp(c) ?? 'unknown';
  const checks = [
    { key: `signin:admin:ip:${ip}`, ...SIGN_IN_LIMITS.perIp },
    { key: `two-factor:admin:user:${userId}`, ...TWO_FACTOR_LIMIT },
  ];
  for (const check of checks) {
    const result = await consumeRateLimit(deps.db, check.key, check.limit, check.windowMs, now);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      deps.logger.warn(
        { requestId: c.get('requestId'), userId, limit: check.key.split(':')[2] },
        'auth.two_factor_rate_limited',
      );
      throw new HttpProblem(429, 'too_many_attempts', 'Too many attempts. Try again later.');
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

/** The admin invitation's one refusal, and the password policy's; anything else passes through. */
function adminInvitationProblem(error: unknown): unknown {
  if (error instanceof IdentityError && error.code === 'invitation_invalid') {
    return new HttpProblem(
      404,
      'invitation_invalid',
      'This invitation link is not valid',
      'It may have been used already or expired. Ask an administrator to send it again.',
    );
  }
  return error instanceof PasswordPolicyError ? invitationProblem(error) : error;
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

  /** Sets the two-factor session's cookie, ending any earlier one. */
  async function startTwoFactorStep(c: Context, token: string) {
    await endTwoFactorStep(c);
    setCookie(c, TWO_FACTOR_COOKIE, token, {
      prefix: 'host',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(TWO_FACTOR_STEP_MS / 1000),
    });
  }

  async function endTwoFactorStep(c: Context) {
    const token = getCookie(c, TWO_FACTOR_COOKIE, 'host');
    if (token === undefined) return;
    await revokeSession(deps.db, token, deps.now());
    deleteCookie(c, TWO_FACTOR_COOKIE, { prefix: 'host', path: '/', secure: true });
  }

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

    if (result.stage === 'two_factor') {
      if (!deps.twoFactorKey) {
        await revokeSession(deps.db, result.token, deps.now());
        deps.logger.error({ requestId: c.get('requestId') }, 'auth.two_factor_not_configured');
        throw new HttpProblem(
          503,
          'two_factor_not_configured',
          'Admin sign-in is not set up yet',
          'ADMIN_TOTP_KEY is not set on the server.',
        );
      }
      await startTwoFactorStep(c, result.token);
      deps.logger.info(
        { requestId: c.get('requestId'), realm, userId: result.user.id, enrolled: result.enrolled },
        'auth.password_accepted',
      );
      return c.json({
        next: result.enrolled ? 'code' : 'enrol',
        expiresAt: result.expiresAt.toISOString(),
      });
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
    if (realm === 'admin') await endTwoFactorStep(c);
    return c.body(null, 204);
  });

  app.get('/me', requireSession(realm, deps), (c) => c.json({ user: c.get('user') }));

  if (realm === 'admin') mountTwoFactorRoutes(app, deps, { startSession, endTwoFactorStep });

  if (realm === 'admin') {
    // Accepting an admin invitation (ADR 0028): it sets the password only. The admin then signs
    // in with it and enrols a second factor. The token travels in the body only, and every
    // refusal (unknown, malformed, used, expired, disabled) is the same.

    /** Who the invitation is for, to show on the accept page. */
    app.post('/invitation', async (c) => {
      const { token } = invitationBody.parse(await c.req.json().catch(() => ({})));
      await enforceInvitationLimits(c, deps, token);
      try {
        const invitation = await findPendingUserInvitation(deps.db, token, deps.now());
        return c.json({
          invitation: {
            email: invitation.email,
            displayName: invitation.displayName,
            expiresAt: invitation.expiresAt.toISOString(),
          },
        });
      } catch (error) {
        throw adminInvitationProblem(error);
      }
    });

    app.post('/accept-invitation', async (c) => {
      const body = acceptBody.parse(await c.req.json().catch(() => ({})));
      await enforceInvitationLimits(c, deps, body.token);
      let user;
      try {
        user = await acceptUserInvitation(deps.db, {
          token: body.token,
          password: body.password,
          now: deps.now(),
        });
      } catch (error) {
        throw adminInvitationProblem(error);
      }
      deps.logger.info(
        { requestId: c.get('requestId'), userId: user.id },
        'auth.admin_invitation_accepted',
      );
      return c.json({ email: user.email });
    });
  }

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

/** Turns a refusal from identity into the answer the browser sees; never which part was wrong. */
function refusal(c: Context, deps: AuthRouteDependencies, result: TwoFactorRefusal): HttpProblem {
  deps.logger.info(
    { requestId: c.get('requestId'), userId: result.userId, reason: result.reason },
    'auth.two_factor_failed',
  );
  if (result.reason === 'no_session') return twoFactorExpired();
  if (result.reason === 'already_enrolled') {
    return new HttpProblem(409, 'already_enrolled', 'Two-factor sign-in is already set up');
  }
  if (result.reason === 'not_enrolled') {
    return new HttpProblem(409, 'not_enrolled', 'Two-factor sign-in is not set up');
  }
  return invalidCode();
}

/**
 * The second factor for admins (ADR 0026): the code step and enrolment, on the two-factor
 * session, and the admin's own changes, on a full session. Mounted under /admin/v1/auth.
 */
function mountTwoFactorRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: AuthRouteDependencies,
  session: {
    startSession: (c: Context, token: string) => Promise<void>;
    endTwoFactorStep: (c: Context) => Promise<void>;
  },
): void {
  const realm = 'admin';

  function key(): TotpKey {
    if (!deps.twoFactorKey) {
      throw new HttpProblem(503, 'two_factor_not_configured', 'Admin sign-in is not set up yet');
    }
    return deps.twoFactorKey;
  }

  /** The live two-factor session of this browser, after the rate limits for its admin. */
  async function step(c: Context) {
    const token = getCookie(c, TWO_FACTOR_COOKIE, 'host');
    const pending = token
      ? await validateTwoFactorSession(deps.db, token, realm, deps.now())
      : undefined;
    if (!token || !pending) throw twoFactorExpired();
    await enforceTwoFactorLimits(c, deps, pending.user.id);
    return {
      pending,
      context: {
        realm,
        token,
        now: deps.now(),
        ipAddress: deps.clientIp(c),
        userAgent: c.req.header('user-agent'),
      } as const,
    };
  }

  /** The code step of sign-in: a code from the app, or a recovery code. */
  app.post('/two-factor/verify', async (c) => {
    const body = verifyBody.parse(await c.req.json().catch(() => ({})));
    const { context } = await step(c);
    const result = await verifySecondFactor(deps.db, key(), {
      ...context,
      ...('code' in body ? { code: body.code } : { recoveryCode: body.recoveryCode }),
    });
    if (!result.ok) throw refusal(c, deps, result);
    await session.endTwoFactorStep(c);
    await session.startSession(c, result.token);
    if (result.usedRecoveryCode) {
      const { recoveryCodesLeft } = await twoFactorStatus(deps.db, result.user.id);
      deps.logger.warn(
        { requestId: c.get('requestId'), userId: result.user.id, recoveryCodesLeft },
        'auth.recovery_code_used',
      );
    }
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        realm,
        userId: result.user.id,
        factor: result.usedRecoveryCode ? 'recovery_code' : 'totp',
      },
      'auth.signed_in',
    );
    return c.json({ user: result.user, expiresAt: result.expiresAt.toISOString() });
  });

  /** Enrolment, first step: a new secret, shown once as text and as a QR code's link. */
  app.post('/two-factor/enrolment', async (c) => {
    const { context } = await step(c);
    const result = await startEnrolment(deps.db, key(), { ...context, issuer: TOTP_ISSUER });
    if (!result.ok) throw refusal(c, deps, result);
    return c.json({ secret: result.secret, uri: result.uri });
  });

  /** Enrolment, second step: the first code confirms it and signs the admin in. */
  app.post('/two-factor/enrolment/confirm', async (c) => {
    const body = confirmBody.parse(await c.req.json().catch(() => ({})));
    const { context } = await step(c);
    const result = await confirmEnrolment(deps.db, key(), { ...context, code: body.code });
    if (!result.ok) throw refusal(c, deps, result);
    await session.endTwoFactorStep(c);
    await session.startSession(c, result.token);
    deps.logger.info(
      { requestId: c.get('requestId'), realm, userId: result.user.id },
      'auth.two_factor_enrolled',
    );
    return c.json({
      user: result.user,
      expiresAt: result.expiresAt.toISOString(),
      recoveryCodes: result.recoveryCodes,
    });
  });

  // The admin's own changes, on a full session. Each needs the password and a current code,
  // and ends the admin's other sessions.
  const signedIn = requireSession(realm, deps);

  app.get('/two-factor', signedIn, async (c) => {
    const status = await twoFactorStatus(deps.db, c.get('user').id);
    return c.json({
      twoFactor: {
        enrolled: status.enrolled,
        confirmedAt: status.confirmedAt?.toISOString() ?? null,
        recoveryCodesLeft: status.recoveryCodesLeft,
      },
    });
  });

  function change(
    c: Context<{ Variables: AuthVariables }>,
    body: { password: string; code: string },
  ) {
    return {
      userId: c.get('user').id,
      sessionId: c.get('sessionId'),
      password: body.password,
      code: body.code,
      now: deps.now(),
    };
  }

  app.post('/two-factor/recovery-codes', signedIn, async (c) => {
    const body = changeBody.parse(await c.req.json().catch(() => ({})));
    await enforceTwoFactorLimits(c, deps, c.get('user').id);
    const result = await replaceRecoveryCodes(deps.db, key(), change(c, body));
    if (!result.ok) throw refusal(c, deps, result);
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id },
      'auth.recovery_codes_replaced',
    );
    return c.json({ recoveryCodes: result.recoveryCodes });
  });

  /** Moving to a new phone, first step: a new secret beside the current one. */
  app.post('/two-factor/replacement', signedIn, async (c) => {
    const body = changeBody.parse(await c.req.json().catch(() => ({})));
    await enforceTwoFactorLimits(c, deps, c.get('user').id);
    const result = await startReplacement(deps.db, key(), {
      ...change(c, body),
      issuer: TOTP_ISSUER,
      email: c.get('user').email,
    });
    if (!result.ok) throw refusal(c, deps, result);
    return c.json({ secret: result.secret, uri: result.uri });
  });

  /** Moving to a new phone, second step: the new phone's first code replaces the old secret. */
  app.post('/two-factor/replacement/confirm', signedIn, async (c) => {
    const body = confirmBody.parse(await c.req.json().catch(() => ({})));
    await enforceTwoFactorLimits(c, deps, c.get('user').id);
    const result = await confirmReplacement(deps.db, key(), {
      userId: c.get('user').id,
      sessionId: c.get('sessionId'),
      code: body.code,
      now: deps.now(),
    });
    if (!result.ok) throw refusal(c, deps, result);
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id },
      'auth.two_factor_replaced',
    );
    return c.json({ recoveryCodes: result.recoveryCodes });
  });
}
