# Muziris

Open-source B2B commerce for businesses that sell to other businesses: negotiated price lists,
company accounts with buyer roles, quick order, RFQs and quotes, approvals, payment terms, GST and
US sales tax. One install runs one business with as many websites as it needs.

Status: **pre-release**. The pilot targets 1 December 2026. Nothing here is production-ready yet.

## What is in this repository

| Path               | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `apps/api`         | The HTTP API (Hono on Node.js): health checks today, the APIs later        |
| `modules/platform` | Organization, websites, and settings that resolve from customer to global  |
| `modules/identity` | Admin and buyer accounts, password hashing, sessions, rate limiting        |
| `modules/access`   | Admin roles and permissions, buyer roles with access levels, query scoping |
| `packages/db`      | PostgreSQL connection and the ordered migration runner                     |
| `packages/money`   | Exact money and decimal maths, currency rules, lakh and crore formatting   |
| `docs/`            | Glossary and architecture decision records                                 |

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

Sign-in endpoints: `POST /admin/v1/auth/sign-in` and `POST /storefront/v1/auth/sign-in` with
`{"email": "...", "password": "..."}`. Requests must come from an origin listed in
`CORS_ORIGINS`.

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
