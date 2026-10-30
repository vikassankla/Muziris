# Muziris

Open-source B2B commerce for businesses that sell to other businesses: negotiated price lists,
company accounts with buyer roles, quick order, RFQs and quotes, approvals, payment terms, GST and
US sales tax. One install runs one business with as many websites as it needs.

Status: **pre-release**. The pilot targets 1 December 2026. Nothing here is production-ready yet.

## What is in this repository

| Path                 | What it is                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| `apps/api`           | The HTTP API (Hono on Node.js): health checks today, the APIs later         |
| `apps/admin`         | The admin app (React, Vite, TanStack Router, shadcn/ui)                     |
| `apps/storefront`    | The buyer storefront: sign-in, catalogue, product prices, search            |
| `modules/platform`   | Organization, websites, and settings that resolve from customer to global   |
| `modules/identity`   | Admin and buyer accounts, password hashing, sessions, rate limiting         |
| `modules/access`     | Admin roles and permissions, buyer roles with access levels, query scoping  |
| `modules/workflow`   | Workflows declared in code: steps, transitions, guards, actions, log        |
| `modules/customers`  | Customer hierarchy, customer groups, buyer users, invitations, addresses    |
| `modules/catalog`    | Simple products, product units with precision, category tree, attributes    |
| `modules/pricing`    | Price lists, assignments, the fallback chain and the combined price build   |
| `modules/visibility` | Product and category visibility rules, the visibility build, buyer scoping  |
| `modules/search`     | Product search: full-text and trigram index, ranking, buyer-scoped search   |
| `packages/db`        | PostgreSQL connection and the ordered migration runner                      |
| `packages/money`     | Exact money and decimal maths, currency rules, lakh and crore formatting    |
| `packages/ui-tokens` | The design tokens (CSS) the admin app and the storefront share              |
| `docs/`              | Glossary, architecture decision records, admin and storefront design boards |

## Run it locally

You need Node.js 22.12 or later, pnpm 10 and Docker.

```sh
cp .env.example .env          # then replace every CHANGE_ME value
docker compose up -d          # PostgreSQL 18, S3-compatible storage, mail catcher
pnpm install
pnpm db:migrate
pnpm --filter @muziris/api admin:create --email you@example.com --name "Your Name"
pnpm --filter @muziris/api dev
```

`admin:create` asks for the password without showing it and gives the new admin the built-in
`administrator` role. For an admin created before roles existed, run it with `--email ... --existing`. Check the API is up with
`curl http://127.0.0.1:4000/health/ready`. Outgoing email appears at http://localhost:8025.

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

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
