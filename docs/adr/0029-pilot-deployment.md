# 0029: Pilot deployment on one VM with Docker Compose and Caddy

- Status: accepted
- Date: 2026-11-04

## Context

The pilot launches on 1 December 2026, "running locally or on a single VM" (`docs/status.md`).
There is no deployment recipe yet:

- `docker-compose.yml` and `docker/app.Dockerfile` are for testing only. The API image keeps dev
  dependencies and runs with `NODE_ENV=development`; nothing serves HTTPS.
- Session cookies use the `__Host-` prefix, which browsers accept only over HTTPS, and each app
  must share one origin with its API path (`docs/install.md`).
- The apps' own files must carry the headers in `docker/app-headers.conf` (no framing,
  `nosniff`, `no-referrer`) and Strict-Transport-Security. The API already sends
  `max-age=63072000; includeSubDomains` with its own responses. The security pass
  (`docs/security-review.md`) left this to the deployment recipe.
- Payment gateways call `/webhooks/` on the storefront's origin, so it must be reachable from
  the internet.
- PostgreSQL is the only infrastructure (ADR 0002). Everything except `ADMIN_TOTP_KEY` is in it.
- The cloud MVP on AWS (end of February 2027) will need its own decision; this one covers the
  pilot only.

## Decision

Ship a production recipe in a new folder, `deploy/`: one Docker Compose file for a single Linux
VM, with **Caddy 2** (one pinned version, Apache-2.0) as the only thing that faces the internet.

### What runs

| Service    | Image                                                         | Published                  |
| ---------- | ------------------------------------------------------------- | -------------------------- |
| `edge`     | Caddy, with the built admin app and storefront baked in       | 80 and 443 only            |
| `api`      | The production API image (below)                              | Nothing; `edge` reaches it |
| `migrate`  | The API image, running `db:migrate` and `setup`, then exiting | Nothing                    |
| `postgres` | `postgres:18-alpine`, data on a named volume                  | Nothing                    |
| `backup`   | `postgres:18-alpine`, running `pg_dump` once a day            | Nothing                    |

No Mailpit and no object storage: email goes to the business's SMTP provider, and nothing uses
object storage yet. Background jobs run inside the API process (ADR 0025), so there is no
separate worker for the pilot.

### Two hostnames, HTTPS from Let's Encrypt

The operator sets `ADMIN_DOMAIN` and `STOREFRONT_DOMAIN` (for example `admin.example.com` and
`shop.example.com`), both pointing at the VM. Caddy gets and renews their certificates itself
and redirects HTTP to HTTPS. Per hostname it:

- serves that app's files, with `index.html` for the app's own routes;
- proxies the app's API paths to `api:4000`: `/admin/v1/` for the admin app, `/storefront/v1/`
  and `/webhooks/` for the storefront; nothing else reaches the API;
- adds the headers of `docker/app-headers.conf` to the app's files, and
  `Strict-Transport-Security: max-age=63072000; includeSubDomains`, matching the API's. No
  `preload`: that is the business's choice for its own domain, and hard to undo;
- limits request bodies to 3 MB, as `docker/nginx.conf` does.

`TRUSTED_PROXY_HOPS` is 1, `CORS_ORIGINS` and the two public URLs are the two `https://` origins,
built from the hostnames in the compose file.

### The production API image

A new `api-prod` target in `docker/app.Dockerfile`:

- `pnpm deploy --prod` copies `@muziris/api` with its workspace packages and production
  dependencies only, so no test or build tools ship.
- It still runs the TypeScript sources with `tsx`, as today, so `tsx` moves from the root's dev
  dependencies to the API's dependencies. Compiling to JavaScript is left to the cloud MVP.
- `NODE_ENV=production`, the `node` user, and the API's health check.

Images are built on the VM from a release tag (`git checkout v0.x.y`, then `docker compose
build`). There is no image registry for the pilot.

### Secrets

All configuration and secrets sit in one file on the VM, `/etc/muziris/muziris.env`, owned by
root with mode `600`, passed to the services with `env_file`. `deploy/muziris.env.example`
lists every variable with no values. The compose file holds no secret, and the repository holds
none (CLAUDE.md).

### Backups

The `backup` service runs `pg_dump --format=custom` once a day into a host folder,
`/var/backups/muziris`, and deletes dumps older than 14 days. Copying them off the VM, and
keeping `ADMIN_TOTP_KEY` with them, is the operator's job; the install guide says how, and how
to restore into an empty database. A restore is tested before launch.

### Upgrades

Back up, check out the new tag, `docker compose build`, `docker compose run --rm migrate`, then
`docker compose up -d`. Migrations only move forward (`docs/install.md`).

### Checking it

A new CI job, "Production stack", builds the images and starts the whole stack with Caddy's
internal certificate authority instead of Let's Encrypt (one variable, for tests only). It
checks that:

- both hostnames answer over HTTPS, and HTTP redirects to HTTPS;
- the apps' files carry every header above, and an API path carries the API's own;
- `/health/ready` is reached only through the API paths, and the API's port is not published;
- the admin app's own routes load `index.html`.

## Consequences

- An operator can install the pilot on any Linux VM with Docker, two DNS names and ports 80
  and 443 open, from one env file. The install guide becomes a step-by-step for this recipe.
- Caddy is a new image to keep patched, and its configuration repeats the headers of
  `docker/app-headers.conf`. The CI job is what keeps them the same; a change to either must
  change both.
- The dev stack (`docker-compose.yml`, nginx) stays as it is, for testing.
- One VM is one point of failure, with up to a day of data lost between dumps unless the
  operator adds point-in-time recovery. That is accepted for the pilot.
- Images built on the VM mean the build needs the VM's CPU and network for a few minutes per
  upgrade. A registry and pre-built images come with the cloud MVP.
- Docker is not installed on the machine this was written on, so the recipe is checked by the
  CI job, not locally.

### Not chosen

- **nginx with certbot:** two processes, and certificate renewal to schedule ourselves. Caddy
  does both in one.
- **The API serving the apps' files and HTTPS itself:** it would put certificates and static
  files into the API process, and still need something to listen on ports 80 and 443.
- **A managed platform:** decided for the cloud MVP, not the pilot.
