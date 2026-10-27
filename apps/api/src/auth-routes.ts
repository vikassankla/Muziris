import { createHash } from 'node:crypto';
import type { Database } from '@muziris/db';
import {
  consumeRateLimit,
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

    // Drop any session this browser already had before handing out a new one.
    const previous = readSessionCookie(c, realm);
    if (previous) await revokeSession(deps.db, previous, deps.now());

    setCookie(c, COOKIE_NAMES[realm], result.token, {
      prefix: 'host',
      httpOnly: true,
      secure: true,
      sameSite: SAME_SITE[realm],
      path: '/',
      maxAge: Math.floor(SESSION_POLICIES[realm].absoluteTimeoutMs / 1000),
    });
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

  return app;
}
