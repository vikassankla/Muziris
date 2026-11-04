# Installing Muziris

This guide is for installing Muziris for a pilot business. The pilot install runs on one Linux
VM with Docker (ADR 0029); running from source on your own servers is at the end. For a quick
look on your own computer, use the Docker test stack in the README instead.

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

## Install on one VM (the pilot)

The pilot install (ADR 0029) runs everything on one Linux VM with Docker Compose:
PostgreSQL, the API, a daily backup, and Caddy, which serves both apps over HTTPS with
certificates from Let's Encrypt. Only Caddy faces the internet. You bring the SMTP server.

### What you need

- A Linux VM with Docker Engine and its Compose plugin, and `git`.
- Two hostnames, one per app (for example `admin.example.com` and `shop.example.com`), each
  with a DNS record pointing at the VM. Let's Encrypt checks them, so set them up first.
- Ports 80 and 443 (TCP), and 443 (UDP) for HTTP/3, open to the internet. Nothing else needs
  to be.
- An SMTP account for the business's emails.

Every command below runs on the VM, from the repository, with `sudo`: the configuration file
can be read by root only.

### 1. Get the release

```sh
sudo git clone https://github.com/vikassankla/Muziris.git /opt/muziris
cd /opt/muziris
sudo git checkout <release tag>
```

Until the first release is tagged, stay on `main` and note the commit you installed
(`git rev-parse --short HEAD`).

### 2. Write the configuration

```sh
sudo install -d -m 700 /etc/muziris
sudo install -m 600 deploy/muziris.env.example /etc/muziris/muziris.env
sudoedit /etc/muziris/muziris.env
```

Fill in every value; the file explains each one. Make the PostgreSQL password with
`openssl rand -hex 24` and `ADMIN_TOTP_KEY` with `openssl rand -base64 32`. This file holds
every secret of the install: never commit it, copy it into a ticket or paste it into a chat.

### 3. Start it

```sh
sudo deploy/muziris up -d --build
```

`deploy/muziris` is `docker compose` with this configuration, so every Compose command works
through it. The first build takes a few minutes. On every start, `migrate` applies the database
migrations and runs `setup` (the organization, product units and standard buyer roles) before
the API starts; both are safe to run again.

### 4. Create the first admin

```sh
sudo deploy/muziris run --rm api tsx src/cli/create-admin.ts --email you@example.com --name "Your Name"
```

It asks for the password without showing it. Use at least 12 characters. The first admin gets
the built-in `administrator` role. At their first sign-in, every admin sets up an
authenticator app (two-factor sign-in, ADR 0026) and saves ten recovery codes.

### 5. Check it

```sh
sudo deploy/check-stack.sh
```

It checks HTTPS and the redirect from HTTP on both hostnames, the security headers, that only
each app's API paths reach the API, that the API and PostgreSQL are not reachable from outside,
and that the latest backup restores into an empty database. Every line should say `ok`.

Then open `https://<ADMIN_DOMAIN>` and set up the business (below).

### Payment gateways

Set the three variables of a gateway in the configuration, then `sudo deploy/muziris up -d`.
In the gateway's dashboard, send events to:

- Stripe: `https://<STOREFRONT_DOMAIN>/webhooks/stripe`
- Razorpay: `https://<STOREFRONT_DOMAIN>/webhooks/razorpay`, with the same
  `RAZORPAY_WEBHOOK_SECRET`.

Keep test-mode keys for the pilot.

### Commands on the VM

The API's commands run inside its container:

| What                                      | Command                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Build prices, visibility or search now    | `sudo deploy/muziris exec api tsx src/cli/build-prices.ts` (`build-visibility.ts`, `build-search.ts`) |
| Send queued emails now                    | `sudo deploy/muziris exec api tsx src/cli/send-emails.ts`                                             |
| Reset the last administrator's two-factor | `sudo deploy/muziris run --rm api tsx src/cli/reset-two-factor.ts --email <email>`                    |
| Add the MRO demo catalog                  | `sudo deploy/muziris exec api tsx src/cli/seed-demo.ts --website <code>`                              |
| Follow the logs                           | `sudo deploy/muziris logs -f api`                                                                     |
| What is running                           | `sudo deploy/muziris ps`                                                                              |

### Backups

The `backup` service writes a `pg_dump` into `/var/backups/muziris` (or `BACKUP_DIR`) when it
starts and then once a day, and deletes dumps older than 14 days. They are on the VM, so they
go with it: copy them somewhere else every day (another machine, or object storage), and keep
`ADMIN_TOTP_KEY` there too. Without the key, every admin must set up two-factor sign-in again
after a restore.

To restore a dump into the install, which replaces everything in its database:

```sh
sudo deploy/muziris stop edge api
sudo deploy/muziris exec backup sh -c 'dropdb "$PGDATABASE" && createdb "$PGDATABASE" && pg_restore --no-owner --exit-on-error --dbname="$PGDATABASE" /backups/<file>.dump'
sudo deploy/muziris up -d
```

Try a restore on a spare VM before launch; `check-stack.sh` already restores the latest dump
into a scratch database each time it runs.

### Upgrades

```sh
cd /opt/muziris
sudo deploy/muziris exec backup sh -c 'pg_dump --format=custom --file=/backups/muziris-upgrade-$(date -u +%Y%m%dT%H%M%SZ).dump'
sudo git fetch --tags
sudo git checkout <new release tag>
sudo deploy/muziris up -d --build
sudo deploy/check-stack.sh
```

`up` rebuilds the images, runs the migrations, then replaces the API and Caddy. Migrations only
move forward: to go back, restore the dump taken before the upgrade and check out the old tag.

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
database, say), use "Build now" in the admin app or the command line (on the VM, see
Commands on the VM):

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
  with `admin_user.manage` resets another admin's under System > Admin users, if they hold
  every permission that admin holds. For the last administrator, run
  `pnpm --filter @muziris/api admin:reset-2fa --email <email>` on the server (on the VM, see
  Commands on the VM). To change
  `ADMIN_TOTP_KEY`, stop the API and any worker, run
  `ADMIN_TOTP_KEY_PREVIOUS=<old> ADMIN_TOTP_KEY=<new> pnpm --filter @muziris/api admin:rotate-2fa-key`,
  then start them with the new key.
- **Logs** are JSON lines on standard output. Passwords, tokens, cookies and authorization
  headers are redacted.
- **Stopping**: the API finishes in-flight requests, and the worker its running job, on
  `SIGTERM` before it exits.
- **Upgrading** (on the VM, see Upgrades above): from source, stop the API and any worker, back up the database, deploy the new version, run
  `pnpm db:migrate`, then start them again. Migrations only move forward.
- **Backups** (on the VM, see Backups above): everything is in PostgreSQL except `ADMIN_TOTP_KEY`. Keep a copy of the key with
  the database credentials, or after a restore every admin must enrol again. Use your provider's point-in-time recovery, or
  `pg_dump` on a schedule, and test a restore before you rely on it.

## Running from source

Without Docker, run the API with Node.js behind your own reverse proxy, and serve the apps'
built files yourself. The pilot VM install above does all of this for you.

### Requirements

- Node.js 22 and pnpm 10.28 (from `packageManager` in `package.json`), to build.
- PostgreSQL 18 with a database and a user that owns it.
- HTTPS for both apps. Session cookies use the `__Host-` prefix, which browsers accept only
  over HTTPS (localhost aside).
- A reverse proxy that serves each app and its API path from the **same origin**:
  - the admin app with `/admin/v1/`;
  - the storefront with `/storefront/v1/` and `/webhooks/`.

  The session cookies are first-party only this way. `docker/nginx.conf` is a working example.

### Configuration

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
| `STRIPE_*`, `RAZORPAY_*`                                             | Optional, all three per gateway. Live keys are refused unless `PAYMENTS_LIVE=true`. `RAZORPAY_WEBHOOK_SECRET` needs 16 or more random characters   |
| `JOB_WORKERS`, `WORKER_PORT`                                         | Optional. `false` stops the API running background jobs; then run the worker (see Running it). The worker's port defaults to 4001                  |

Build-time, for the storefront: `VITE_STOREFRONT_WEBSITE`, the same website code.

### Build

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

### First run

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

## Not ready for production yet

These are open before the first production install (see `docs/status.md`):

- **Tax** needs the tax adviser's confirmation of the four **(check)** items in ADR 0017 before
  live orders.
- **The VM install** has been checked by CI's "Production stack" job only, with Caddy's own
  certificates. Install it once on a real VM with real DNS and Let's Encrypt before launch.
- **Payments** stay in test mode for the pilot. Live keys need `PAYMENTS_LIVE=true` and a
  second review of the gateway setup.
