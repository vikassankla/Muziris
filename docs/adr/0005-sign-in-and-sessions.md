# 0005: Sign-in with Argon2id and server-side cookie sessions

- Status: accepted
- Date: 2026-10-27

## Context

Admins and buyers sign in with an email and password. Admin accounts can change prices and
permissions, so they are high-value targets. The storefront and admin are browser apps on the
same site as the API. Requirements: OWASP ASVS 5.0 level 2, no extra infrastructure beyond
PostgreSQL (ADR 0002).

## Decision

- Two realms, admin and buyer, kept apart everywhere: separate user rows (the same email may
  exist in both), separate session cookies, and each API checks only its own realm.
- Passwords: Argon2id at the OWASP baseline (19 MiB, 2 iterations, 1 lane), NFKC-normalised,
  12 to 128 code points, no composition rules, common and email-derived passwords refused.
  Hashes are upgraded automatically on sign-in when the parameters are raised.
- Sessions are opaque 256-bit random tokens in `__Host-` cookies (HttpOnly, Secure, Path=/, no
  Domain; SameSite=Strict for admin, Lax for buyers so order-email links work). Only the
  SHA-256 of a token is stored. Server-side storage means sign-out, password change and
  disabling an account end sessions immediately, which stateless tokens cannot do.
- Timeouts: admin 30 minutes idle and 12 hours absolute; buyer 3 days idle and 30 days
  absolute.
- Brute force: an account locks after 5 consecutive failures for 1 minute, doubling to at most
  15 minutes. Sign-in is also limited to 20 attempts per IP and 10 per email in 10 minutes,
  counted in PostgreSQL so limits hold across processes. Rate-limit keys store a hash, never
  the email.
- Every failure returns the same 401 message and takes about the same time (an Argon2id
  verification runs even for unknown emails), so responses never reveal which accounts exist.
  The real reason goes to the logs, without the email or password.
- Cross-site request forgery: state-changing requests must carry an Origin from the allowlist,
  or `Sec-Fetch-Site: same-origin` when no Origin is sent.

## Consequences

- Every authenticated request costs one indexed query; last-seen is written at most once a
  minute per session.
- Expired and revoked sessions and old rate-limit counters need a periodic cleanup job
  (`deleteDeadSessions`, `pruneRateLimits`), to be scheduled when the job runner lands.
- Multi-factor authentication and SSO (OIDC, SAML) are not in this decision. Admin MFA should
  come before the first production install.
- Behind a load balancer, `TRUSTED_PROXY_HOPS` must be set correctly, or every user shares the
  balancer's IP for rate limiting.
