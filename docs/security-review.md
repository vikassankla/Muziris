# Security pass, November 2026

The pilot plan's security pass (week 5), done on 2026-11-04 against `main` at 4b4698e. It reads
the code against the security rules in `CLAUDE.md` and the usual web application risks. It is a
review by reading the code and running the tests, not a penetration test; the deployment
recipe (launch prep) is reviewed when it is written.

Every fix is in the pull request that adds this file, with tests. It touches authentication,
payments and secrets, so it needs a second human reviewer under `CLAUDE.md` rule 4.

## Findings

| #   | Finding                                                                       | Severity | Status                     |
| --- | ----------------------------------------------------------------------------- | -------- | -------------------------- |
| 1   | Database errors put query values in the logs and in pg-boss's job table       | Medium   | Fixed                      |
| 2   | The admin app has no content security policy, and neither app forbids frames  | Medium   | Fixed                      |
| 3   | The sign-in redirect can be sent to another site with a tab or line break     | Low      | Fixed                      |
| 4   | A Razorpay webhook secret of any length is accepted                           | Low      | Fixed                      |
| 5   | An admin user can disable or reset an admin user who holds more permissions   | Low      | Fixed (ADR 0028 amended)   |
| 6   | Anyone can lock an account for a while by failing its sign-in                 | Low      | Accepted (ADR 0005)        |
| 7   | Two admin users disabled at the same moment can leave no active administrator | Low      | Accepted (known, ADR 0028) |

### 1. Database errors put query values in the logs and in pg-boss's job table

Drizzle wraps a failed query in `DrizzleQueryError`, whose message and `params` hold every value
the query was sent with, and PostgreSQL's own error repeats values in `detail` ("Key (realm,
email)=(admin, asha@example.com) already exists") and `where`. The API logs an unhandled error
in full, so a query that failed for a reason the code does not expect (a timeout, a serialization
failure, an unforeseen constraint) wrote emails, addresses, password hashes, token hashes or
encrypted two-factor secrets to the log. The job runner logged the same error and rethrew it to
pg-boss, which keeps what a failed job throws in `pgboss.job.output`.

Fixed: `withoutQueryValues` in `@muziris/db` copies an error and its causes without the values
(the query text, PostgreSQL's code and the table, column and constraint names stay). The API's
logger passes every `err` through it, and the job runner throws pg-boss an error that only names
the job and the log entry. Tests: `packages/db/src/errors.test.ts`,
`apps/api/src/logger.test.ts` and a new case in `packages/jobs/src/runner.integration.test.ts`,
which fails without the fix.

### 2. The admin app has no content security policy, and neither app forbids frames

The storefront's build writes a content security policy into `index.html`; the admin app's did
not, although the admin app is the more valuable target. A policy in a meta tag cannot set
`frame-ancestors`, and nginx (`docker/nginx.conf`) sent no headers for the apps' files, so
another site could show either app in a frame and trick an admin user into clicks.

Fixed: the admin build writes a policy that allows this origin only (`script-src 'self'`,
`connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`; styles may be inline, for Radix and
the toasts). nginx sends `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` with both apps' files
(`docker/app-headers.conf`). The end-to-end journeys now fail on any content security policy
violation in either app, including the two-factor enrolment with its QR code. On its first run
that check found the storefront's existing policy refusing the font files the build inlines as
`data:` URLs, so some text fell back to another font; both policies now allow `data:` fonts. The deployment
recipe must send the same headers, and `Strict-Transport-Security` behind HTTPS.

### 3. The sign-in redirect can be sent to another site with a tab or line break

`safeRedirect` (admin app and storefront) refused `//evil.example` and `/\evil.example`, but not
`/<tab>/evil.example`: browsers drop tabs and line breaks from URLs, so it becomes
`//evil.example`. A crafted sign-in link could send a user who has just signed in to another
site.

Fixed: the value is read as a browser reads a URL and must stay on this origin; control
characters and backslashes are refused outright. Tests in both apps' `src/lib/redirect.test.ts`.

### 4. A Razorpay webhook secret of any length is accepted

Razorpay's webhook secret is whatever the operator types in its dashboard. A short one could be
guessed, and a correctly signed webhook may mark a payment paid. Stripe's secrets are generated.

Fixed: `RAZORPAY_WEBHOOK_SECRET` must be at least 16 characters, or the API refuses to start, as
for other configuration problems, without printing the value. `.env.example` and
`docs/install.md` say so.

### 5. An admin user can disable or reset an admin user who holds more permissions

`admin_user.manage` let an admin user disable, enable or reset the two-factor sign-in of any
other admin user, including administrators. No account is taken over (a reset admin user still
needs their password, and the last active administrator cannot be disabled), but an admin user
with a narrow role could lock every other administrator out until one of them is enabled again.
Giving and changing roles already required holding every permission involved; these actions did
not.

Fixed, as Vikas decided on 2026-11-04 (ADR 0028, amended): disabling, enabling and resetting
two-factor sign-in need every permission the other admin user holds, so only an admin user with
every permission may act on an administrator; anything else is refused with `outranked`. The
list says whom the signed-in admin may act on (`mayManage`) and the screen offers only those
actions. Tests: the access module's integration tests, `admin-users-routes.integration.test.ts`
and `admin-users.test.tsx`.

### 6. Anyone can lock an account for a while by failing its sign-in

Failed sign-ins lock the account for a growing time (ADR 0005), and the per-email rate limit
refuses further attempts for ten minutes. Anyone who knows an email can keep that account
locked out. This is the usual price of slowing password guessing, and the lock is short;
accepted.

### 7. Two admin users disabled at the same moment can leave no active administrator

Known from ADR 0028 and noted in `docs/status.md`: the last-administrator check does not lock,
so two admin users disabling the last two administrators at the same moment could both pass.
`pnpm --filter @muziris/api admin:create` makes a new administrator to recover. Accepted for
the pilot.

## What was checked and held

- **Sessions and sign-in.** Session tokens are 256 random bits, stored as SHA-256 and checked in
  the query, with the realm, the stage (a password-only admin session is never a full one), the
  user's status and both timeouts. Cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`
  for admin users and `Lax` for buyer users. Signing in drops the browser's earlier session.
  Passwords are Argon2id; an unknown email, a disabled or locked account and a missing password
  spend the same time as a wrong password and get the same answer. Sign-in, the code step and
  invitation links are rate limited by IP and by account or token.
- **Cross-site requests.** Every route group checks `Origin` (or `Sec-Fetch-Site`) on
  state-changing requests; CORS answers listed origins only. The storefront's GET requests run
  queries only.
- **Permissions.** Every admin route needs a session, and every one except `/access/me` and the
  website list (both needed by every screen) names its permission. No role can be given, and no
  permission added to a role, that the admin user does not hold.
- **Buyer data.** Every storefront query and mutation passes the signed-in buyer user, and the
  modules scope it in the query itself (shopping lists, orders, payments, addresses, prices,
  visibility). Inactive websites answer as missing. Introspection and ad hoc queries are off in
  production, with depth, cost and size limits.
- **Payment webhooks.** The signature is checked over the raw body before it is read, in
  constant time, with Stripe's timestamp tolerance; amounts and currencies must match the
  payment; repeated events change nothing.
- **SQL.** Queries go through Drizzle or the `sql` template. The few `sql.raw` calls hold
  constants, a type name from the code, or text whose values are bound separately.
- **Output.** Emails escape every value and build links from configured `https` URLs. React
  escapes the apps' output and nothing uses `dangerouslySetInnerHTML`. CSV exports hold SKUs,
  unit codes and numbers whose rules forbid a leading `=`, `+`, `-` or `@`.
- **Errors and logs.** Errors the caller sees are problem+json with a stable code; anything
  else is a generic 500. Request ids are accepted only in a safe shape. The logs redact
  passwords, tokens, cookies, gateway keys and the SMTP URL by field name, and now database
  values (finding 1).
- **Client addresses.** `X-Forwarded-For` is trusted only as far as `TRUSTED_PROXY_HOPS`.
