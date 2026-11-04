# Muziris

Open-source B2B commerce for businesses that sell to other businesses: negotiated price lists,
company accounts with buyer roles, quick order, RFQs and quotes, approvals, payment terms, GST and
US sales tax. One install runs one business with as many websites as it needs.

Status: **pre-release**. The pilot targets 1 December 2026. Nothing here is production-ready yet.

## What is in this repository

| Path                     | What it is                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- |
| `apps/api`               | The HTTP API (Hono on Node.js): health checks today, the APIs later           |
| `apps/admin`             | The admin app (React, Vite, TanStack Router, shadcn/ui)                       |
| `apps/storefront`        | The buyer storefront: catalogue, search, lists, quick order, checkout, orders |
| `modules/platform`       | Organization, websites, and settings that resolve from customer to global     |
| `modules/identity`       | Admin and buyer accounts, password hashing, sessions, rate limiting           |
| `modules/access`         | Admin roles and permissions, buyer roles with access levels, query scoping    |
| `modules/workflow`       | Workflows declared in code: steps, transitions, guards, actions, log          |
| `modules/customers`      | Customer hierarchy, customer groups, buyer users, invitations, addresses      |
| `modules/catalog`        | Simple products, product units with precision, category tree, attributes      |
| `modules/pricing`        | Price lists, assignments, the fallback chain and the combined price build     |
| `modules/visibility`     | Product and category visibility rules, the visibility build, buyer scoping    |
| `modules/search`         | Product search: full-text and trigram index, ranking, buyer-scoped search     |
| `modules/tax`            | GST and US sales tax: registrations, dated rates, exemptions, the provider    |
| `modules/orders`         | Checkout (preview and place), the totals pipeline, orders and their workflow  |
| `modules/shopping-lists` | Shopping lists scoped by buyer access level, lines with notes                 |
| `modules/payments`       | Stripe and Razorpay payments for orders, signed webhooks, the event log       |
| `modules/notifications`  | Transactional emails: the outbox, templates, the SMTP sender                  |
| `packages/db`            | PostgreSQL connection and the ordered migration runner                        |
| `packages/money`         | Exact money and decimal maths, currency rules, lakh and crore formatting      |
| `packages/ui-tokens`     | The design tokens (CSS) the admin app and the storefront share                |
| `docs/`                  | Glossary, architecture decision records, admin and storefront design boards   |

## Run it locally

You need Node.js 22.12 or later, pnpm 10 and Docker.

```sh
cp .env.example .env          # then replace every CHANGE_ME value
docker compose up -d          # PostgreSQL 18, S3-compatible storage, mail catcher
pnpm install
pnpm db:migrate
pnpm --filter @muziris/api run setup --organization "Your Company"
pnpm --filter @muziris/api admin:create --email you@example.com --name "Your Name"
pnpm --filter @muziris/api dev
```

`admin:create` asks for the password without showing it and gives the new admin the built-in
`administrator` role. Admins sign in with an authenticator app as well (ADR 0026): set
`ADMIN_TOTP_KEY` in `.env` first (`openssl rand -base64 32`), and the first sign-in sets the app
up. `setup` creates the organization and the standard product units, and can
be run again safely. Then create the first website and its settings in the admin app, under
System > Websites and System > Settings. For an admin created before roles existed, run it with `--email ... --existing`. Check the API is up with
`curl http://127.0.0.1:4000/health/ready`. Outgoing email appears at http://localhost:8025.
The API also runs the background jobs (builds, emails, session clean-up; ADR 0025); with
`JOB_WORKERS=false` they run in `pnpm --filter @muziris/api worker` instead.

To install Muziris for a business, see the [install guide](docs/install.md): the pilot install
runs on one VM from `deploy/` (ADR 0029).

### Everything in Docker, for testing

To try the whole application without Node.js, run it in Docker. This is a test setup, not a
production one: the API runs with `NODE_ENV=development` and dev dependencies. The pilot install
is in `deploy/`.

```sh
cp .env.example .env          # then replace every CHANGE_ME value
docker compose --profile app up -d --build --wait
docker compose exec api pnpm --filter @muziris/api admin:create --email you@example.com --name "Your Name"
```

- The admin app is at http://localhost:8080 and the storefront at http://localhost:8081. nginx
  serves both and passes `/admin/v1` and `/storefront/v1` to the API, so each stays on one
  origin.
- Outgoing email appears at http://localhost:8025.
- The `migrate` service applies the migrations and runs `setup` on every start, then exits.
  Set `ORGANIZATION_NAME` in `.env` to name the organization; it defaults to "Muziris Test".
- The storefront serves the website whose code is `STOREFRONT_WEBSITE` (default `main`). Create
  a website with that code in the admin app, then rebuild with `--build` if you change it.
- Stripe and Razorpay test keys in `.env` reach the API; without them checkout offers payment
  terms only.
- For a catalog to try, add the MRO demo: about 40 bearings, fasteners, safety items, tools,
  lubricants and electrical parts with HSN codes and list prices with breaks at 10 and 100, in
  INR or USD by the website's currency. It adds no tax rates or registrations; enter those
  under System > Tax before checking out. Run it again safely, once per website:
  `docker compose exec api pnpm --filter @muziris/api run demo:seed --website main`.
- After changing the code, run the same `up` command again to rebuild.
- `docker compose --profile app down` stops everything. Add `-v` to delete the database too.

### The admin app

With the API running on `127.0.0.1:4000`, start the admin app in a second terminal:

```sh
pnpm --filter @muziris/admin dev    # http://localhost:5173
```

Sign in with the admin you made with `admin:create`. The Vite dev server proxies `/admin/v1` to
the API, so the app and the API share one origin and the `__Host-` session cookie stays
first-party. `http://localhost:5173` must be in `CORS_ORIGINS`, because the API checks the
Origin of every sign-in and change. The app keeps no tokens; browser storage holds only the theme and sidebar preferences. In
the Claude desktop app, `.claude/launch.json` has `admin` and `api` entries for the same
commands. In production, serve the built app (`pnpm --filter @muziris/admin build`, output in
`apps/admin/dist`) from the same origin as the API, behind one reverse proxy.

Sign-in endpoints: `POST /admin/v1/auth/sign-in` and `POST /storefront/v1/auth/sign-in` with
`{"email": "...", "password": "..."}`. Requests must come from an origin listed in
`CORS_ORIGINS`.

The storefront API is GraphQL at `/storefront/v1/graphql` (ADR 0014), for a signed-in buyer,
with the website code in a `Muziris-Website` header. Outside production it takes ad hoc
queries; in production only persisted queries, from the file `STOREFRONT_PERSISTED_QUERIES`
names. The schema is in `apps/api/src/storefront/schema.graphql`.

Checkout (`checkoutPreview`, `placeOrder`) charges GST or US sales tax from the tax tables
(ADR 0017). Before a website can take orders, an admin with `tax.manage` enters its
registration (a GSTIN, or US permits per state) and rates under `/admin/v1/tax`, and each
product needs its HSN or SAC code (India). A missing code, rate or registration refuses checkout
with `TAX_PROBLEMS`, naming the lines; nothing is sold without tax. Orders are listed and moved
through their workflow under `/admin/v1/orders`.

Orders can be paid on terms or online through Stripe or Razorpay in test mode (ADR 0019); the
gateway keys come from the environment (see `.env.example`). Invitations, order updates and
payments send emails through an outbox (ADR 0020); locally Mailpit receives them at
http://localhost:8025. The catalogue of emails is in `docs/notifications.md`.

### The storefront app

The storefront (ADR 0015) is for signed-in buyers. In `.env`, set `VITE_STOREFRONT_WEBSITE` to
the code of the website it serves, add `http://localhost:5174` to `CORS_ORIGINS`, and set
`STOREFRONT_PERSISTED_QUERIES=../storefront/persisted-queries.json` so the API knows the app's
operations. Then, with the API running:

```sh
pnpm --filter @muziris/storefront dev    # http://localhost:5174
```

Sign in as a buyer user of a customer (invite one from the admin app). The dev server proxies
`/storefront/v1` to the API. The app sends each operation as a GET with its hash only, never
the query text, in every environment. Its operations are in
`apps/storefront/src/operations/*.graphql`; after changing one, or the API schema, run
`pnpm --filter @muziris/storefront operations` to rewrite `generated.ts` and
`persisted-queries.json` (a test fails when they are stale). `.claude/launch.json` has a
`storefront` entry. In production, serve `apps/storefront/dist` from the same origin as the API.

## Checks

```sh
pnpm check                    # format, lint, typecheck and tests
TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/muziris_test pnpm test
```

Database tests run only when `TEST_DATABASE_URL` is set. Each test file creates and uses its own
database next to it (for example `muziris_test_identity`) and empties its tables between tests,
so point it at a server where those databases can be thrown away. The database user needs
permission to create databases.

### End-to-end journeys

```sh
pnpm --filter @muziris/e2e exec playwright install chromium   # once
E2E_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/muziris pnpm e2e
```

The journeys (ADR 0024, in `e2e/tests`) build the admin app and the storefront, start the API on
port 4100 and both apps on 4180 and 4181, and drive them in Chromium. They need PostgreSQL and
Mailpit, which `docker compose up -d` starts. Every run drops and creates the database
`muziris_e2e` on the server `E2E_DATABASE_URL` points at (or else `TEST_DATABASE_URL`'s), and
leaves every other database alone. Add `--ui` to watch them, or `--project chromium -g "tax"` to
run one. A failed test keeps a trace: `pnpm --filter @muziris/e2e exec playwright show-trace`.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
