# 0001: One deployable core with strict module boundaries

- Status: accepted
- Date: 2026-10-27

## Context

Muziris covers many business areas (catalog, pricing, checkout, orders, CRM) that must stay
consistent with each other, and it is built by a small team with AI agents. Separate services
would add network calls, distributed transactions and deployment work before any of that scale is
needed.

## Decision

Build one TypeScript core, deployed as an API process plus background workers running the same
code. Each business area is a module under `modules/` that owns its tables (prefixed with the
module name) and exposes a public interface in `src/index.ts`. Modules never read each other's
tables. The linter blocks imports that bypass a module's public interface.

## Consequences

- One transaction can cover an order and its stock reservation without a distributed protocol.
- A module can later move into its own service, because nothing outside it touches its tables.
- Boundaries need discipline: a convenient join across modules is not allowed; the owning module
  must offer a function instead.
