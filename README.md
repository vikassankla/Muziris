# Muziris

Open-source B2B commerce for businesses that sell to other businesses: negotiated price lists,
company accounts with buyer roles, quick order, RFQs and quotes, approvals, payment terms, GST and
US sales tax. One install runs one business with as many websites as it needs.

Status: **pre-release**. The pilot targets 1 December 2026. Nothing here is production-ready yet.

## What is in this repository

| Path               | What it is                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| `apps/api`         | The HTTP API (Hono on Node.js): health checks today, the APIs later       |
| `modules/platform` | Organization, websites, and settings that resolve from customer to global |
| `packages/db`      | PostgreSQL connection and the ordered migration runner                    |
| `packages/money`   | Exact money and decimal maths, currency rules, lakh and crore formatting  |
| `docs/`            | Glossary and architecture decision records                                |

## Run it locally

You need Node.js 22.12 or later, pnpm 10 and Docker.

```sh
cp .env.example .env          # then replace every CHANGE_ME value
docker compose up -d          # PostgreSQL 18, S3-compatible storage, mail catcher
pnpm install
pnpm db:migrate
pnpm --filter @muziris/api dev
```

Check it is up: `curl http://127.0.0.1:4000/health/ready`. Outgoing email appears at
http://localhost:8025.

## Checks

```sh
pnpm check                    # format, lint, typecheck and tests
TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/muziris_test pnpm test
```

Database tests run only when `TEST_DATABASE_URL` is set, and they empty the tables they use, so
always point it at a database you can throw away.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
