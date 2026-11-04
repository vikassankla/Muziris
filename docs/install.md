# Installing Muziris

**First draft (2026-11-03).** This guide is for installing Muziris for a pilot business. It covers
what an install needs, the first-run steps, and what is not ready for production yet. For a
quick look on your own computer, use the Docker test stack in the README instead.

## What an install is

One install runs one business (the organization). It can have several websites, each with its
own country (India or the US during the pilot), currency, locale and time zone.

| Part           | What it is                                                                                                                                  | Runs as                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| API            | `apps/api`: the admin API (`/admin/v1`), the storefront GraphQL API (`/storefront/v1`), payment webhooks (`/webhooks`) and the email sender | A Node.js 22 process         |
| Admin app      | `apps/admin`: static files from `vite build`                                                                                                | Any web server               |
| Storefront     | `apps/storefront`: static files from `vite build`, built for one website                                                                    | Any web server               |
| PostgreSQL 18  | The only database: data, search and settings                                                                                                | A managed or self-run server |
| SMTP server    | Invitation and order emails                                                                                                                 | Any provider                 |
| Object storage | S3-compatible; reserved for uploads                                                                                                         | Any S3-compatible service    |

Payment gateways (Stripe, Razorpay) are optional. Without them, checkout offers payment on
terms only.

## Requirements

- Node.js 22 and pnpm 10.28 (from `packageManager` in `package.json`), to build.
- PostgreSQL 18 with a database and a user that owns it.
- HTTPS for both apps. Session cookies use the `__Host-` prefix, which browsers accept only
  over HTTPS (localhost aside).
- A reverse proxy that serves each app and its API path from the **same origin**:
  - the admin app with `/admin/v1/`;
  - the storefront with `/storefront/v1/` and `/webhooks/`.

  The session cookies are first-party only this way. `docker/nginx.conf` is a working example.

## Configuration

Configuration comes from environment variables only. `.env.example` lists them with
comments. The API checks them at startup, and when one is wrong it names the variable without
printing its value.

Secrets (the database password inside `DATABASE_URL`, `ADMIN_TOTP_KEY`, `SMTP_URL`, the payment keys) belong in
your deployment's secret store. Never put them in the repository, the admin settings or a URL
you share.

For production, set at least:

| Variable                                                             | Value                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                           | `production`                                                                                                                                       |
| `DATABASE_URL`                                                       | `postgres://user:password@host:5432/database`                                                                                                      |
| `ADMIN_TOTP_KEY`                                                     | 32 random bytes in base64 (`openssl rand -base64 32`). Encrypts admins' two-factor secrets; back it up with the database credentials               |
| `HOST`, `PORT`                                                       | Where the API listens, for example `0.0.0.0` and `4000` behind the proxy                                                                           |
| `CORS_ORIGINS`                                                       | The admin and storefront origins, comma-separated. They must be `https://` in production                                                           |
| `TRUSTED_PROXY_HOPS`                                                 | How many proxies sit in front of the API (1 for one reverse proxy), so rate limits see the client's address                                        |
| `STOREFRONT_WEBSITE`                                                 | The code of the website the storefront serves                                                                                                      |
| `STOREFRONT_PERSISTED_QUERIES`                                       | `../storefront/persisted-queries.json`. Production runs persisted queries only, and refuses `STOREFRONT_ADHOC_QUERIES=allow`                       |
| `SMTP_URL`, `MAIL_FROM`, `STOREFRONT_PUBLIC_URL`, `ADMIN_PUBLIC_URL` | All four are required in production. The two URLs are used for links in emails: the storefront's for buyers, the admin app's for admin invitations |
| `STRIPE_*`, `RAZORPAY_*`                                             | Optional, all three per gateway. Live keys are refused unless `PAYMENTS_LIVE=true`                                                                 |
| `JOB_WORKERS`, `WORKER_PORT`                                         | Optional. `false` stops the API running background jobs; then run the worker (see Running it). The worker's port defaults to 4001                  |

Build-time, for the storefront: `VITE_STOREFRONT_WEBSITE`, the same website code.

## Build

```sh
pnpm install --frozen-lockfile
pnpm build
```

This builds the static files into `apps/admin/dist` and `apps/storefront/dist`. The API runs
from its TypeScript sources with `tsx` (`pnpm --filter @muziris/api start`), so keep the
repository and its dependencies on the API host.

If you change the storefront's GraphQL operations, run
`pnpm --filter @muziris/storefront operations` to regenerate `persisted-queries.json` before
building.

## First run

Run these once, in order, with the environment set:

```sh
pnpm db:migrate
pnpm --filter @muziris/api run setup --organization "Your Company"
pnpm --filter @muziris/api admin:create --email you@example.com --name "Your Name"
pnpm --filter @muziris/api start
```

- `db:migrate` applies the database migrations. Run it again before starting each new version.
- `setup` creates the organization and the standard product units (each, pack, kg, m, l). It
  is safe to run again and changes nothing the second time.
- `admin:create` asks for the password without showing it. Use at least 12 characters. The
  first admin gets the built-in `administrator` role.
- At their first sign-in, every admin sets up an authenticator app (two-factor sign-in, ADR 0026) and saves ten recovery codes. No admin screen opens until they have.

Check the API: `/health/live` answers when the process runs, and `/health/ready` answers when
it can reach the database. Point your load balancer's checks at them.

## Set up the business in the admin app

Sign in to the admin app, then:

1. **System > Websites**: create the website whose code is `STOREFRONT_WEBSITE`, with its
   country, currency, locale and time zone. You can't change its code, country or currency later.
2. **System > Settings**: check shipping, payment methods, payment terms, the order email
   and the order number prefix for that website.
3. **System > Tax**: enter the GSTIN (India) or the states where you hold a sales tax permit
   (US), and the rates. The Readiness list says what would still refuse a checkout. Rates are
   the business's own, confirmed with its tax adviser; Muziris ships none.
4. **Catalog**: product units, categories and products, with an HSN or SAC code (India) or a
   US tax category on each product.
5. **Pricing > Price lists**: a price list in the website's currency, assigned to the
   website. Then build prices.
6. **Buyer roles** and **System > Settings > Customers**: make sure a buyer role lets buyers
   order, and set it as the default buyer role, so invited buyers can order as soon as they
   accept.
7. **Customers**: create a customer with an address and invite a buyer. The invitation email
   carries the sign-in link.

Price lists, visibility and search are served from builds. Changes made in the admin app queue
the price and visibility builds, which start about 15 seconds later, so a burst of edits builds
once. To build at once, or after changes made outside the admin app (an import into the
database, say), use "Build now" in the admin app or the command line:

```sh
pnpm --filter @muziris/api pricing:build
pnpm --filter @muziris/api visibility:build
pnpm --filter @muziris/api search:build
```

For a demonstration install, `pnpm --filter @muziris/api run demo:seed --website <code>` adds
an MRO catalog with list prices, if your version includes it. It adds no tax rates.

## Running it

- **Background jobs** (ADR 0025) run in the API process by default, on pg-boss in the same
  database (schema `pgboss`, installed by `pnpm db:migrate`). They build prices, visibility and
  search after changes, send emails, and clear dead sessions hourly. **System > Jobs** in the
  admin app lists the jobs waiting, running and failed. To run them apart from the API, set
  `JOB_WORKERS=false` on the API and run `pnpm --filter @muziris/api worker` as its own service.
  Run one or more workers; a job runs once whichever picks it up.
- **Emails** are sent within seconds of being queued, and every minute, while `SMTP_URL` is
  set. You can also send them with `pnpm --filter @muziris/api notifications:send`.
- **Admin two-factor sign-in** (ADR 0026). An admin who loses their phone signs in with a
  recovery code, then moves to a new phone under Security in their profile menu. An admin
  with `admin_user.manage` can reset another admin's, through
  `POST /admin/v1/access/admin-users/<id>/two-factor/reset` until the admin users screen
  exists. For the last administrator, run
  `pnpm --filter @muziris/api admin:reset-2fa --email <email>` on the server. To change
  `ADMIN_TOTP_KEY`, stop the API and any worker, run
  `ADMIN_TOTP_KEY_PREVIOUS=<old> ADMIN_TOTP_KEY=<new> pnpm --filter @muziris/api admin:rotate-2fa-key`,
  then start them with the new key.
- **Logs** are JSON lines on standard output. Passwords, tokens, cookies and authorization
  headers are redacted.
- **Stopping**: the API finishes in-flight requests, and the worker its running job, on
  `SIGTERM` before it exits.
- **Upgrading**: stop the API and any worker, back up the database, deploy the new version, run
  `pnpm db:migrate`, then start them again. Migrations only move forward.
- **Backups**: everything is in PostgreSQL except `ADMIN_TOTP_KEY`. Keep a copy of the key with
  the database credentials, or after a restore every admin must enrol again. Use your provider's point-in-time recovery, or
  `pg_dump` on a schedule, and test a restore before you rely on it.

## Not ready for production yet

These are open before the first production install (see `docs/status.md`):

- **No production container image.** The Docker setup in this repository is for testing: it
  runs with `NODE_ENV=development` and dev dependencies.
- **Tax** needs the tax adviser's confirmation of the four **(check)** items in ADR 0017 before
  live orders.
- **Payments** stay in test mode for the pilot. Live keys need `PAYMENTS_LIVE=true` and a
  second review of the gateway setup.
