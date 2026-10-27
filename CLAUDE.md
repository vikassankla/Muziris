# Conventions for AI agents and human contributors

Read this file before writing code in this repository. It is the source of truth for how code is
written here; when it disagrees with habit or a generic best practice, follow this file. If a rule
here is wrong, change the file in its own pull request.

## Ground rules

1. Never copy code from OroCommerce or any copyleft project. Read them for behaviour only.
2. Work on one module per task, on its own branch, against written acceptance criteria.
3. Never weaken, skip or delete a test to make code pass. Fix the code, or explain in the pull
   request why the test was wrong and get reviewer sign-off.
4. Changes to payments, tax, pricing, access control, authentication or secrets need a second
   human reviewer. Say so in the pull request.
5. Run `pnpm check` before declaring work done. With a database available, also run the
   integration tests with `TEST_DATABASE_URL` set.
6. Record every structural decision as an ADR in `docs/adr/` (copy the template).
7. Use the terms in `docs/glossary.md` exactly. Do not invent synonyms in code or UI.

## Layout

- `apps/*` are deployable programs (API, admin, storefront). They wire modules together and hold
  no business rules.
- `modules/*` hold business capabilities. Each owns its tables in `src/db/schema.ts`, prefixed
  with the module name (`platform_website`). Public interface: `src/index.ts` only.
- `packages/*` are shared, domain-free libraries (database client, money).
- A module may depend on `packages/*` and on other modules' public interfaces. It must never read
  or write another module's tables. The linter blocks deep imports.

## TypeScript

- Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`; use
  `unknown` and narrow it.
- Only erasable syntax: no enums, namespaces or constructor parameter properties. Use
  `as const` objects and string unions instead of enums.
- ES modules with explicit `.js` extensions in relative imports.
- Prefer plain functions and data over classes. Classes are for errors.
- Never use non-null assertions (`!`) outside tests; handle the missing case.

## Money, quantities and time

- Money is `Money` from `@muziris/money`: integer minor units plus a currency. Never use
  JavaScript numbers for money, rates or quantities in calculations; use the decimal helpers.
- Round once, at a documented step, with an explicit rounding mode.
- Store timestamps as `timestamp with time zone` in UTC. Convert to the website's time zone only
  for display.
- Follow the India and US data rules in the requirements spec (PIN codes, GST state codes, GSTIN,
  HSN and SAC codes, ZIP codes, metric and imperial units).

## Validation and errors

- Validate every input at the boundary with zod: HTTP bodies, query strings, environment,
  messages from the queue, and data from integrations.
- Validate again in the database with constraints (checks, foreign keys, unique keys) for
  anything that must never be wrong.
- HTTP errors use RFC 9457 problem+json with a stable `code`. Throw `HttpProblem` for errors the
  caller may see; anything else becomes a generic 500 and its details stay in the logs.

## Security

- Secrets come only from the environment and never appear in logs, errors, URLs or the
  repository. Do not log request bodies or query strings.
- Use parameterised queries through Drizzle or the `sql` template. Never build SQL by string
  concatenation.
- Every database query that returns buyer data must be scoped to the caller's customer and
  access level in the query itself, not filtered afterwards.
- Passwords are hashed with Argon2id. Tokens are random, stored hashed, and compared in constant
  time.
- Keep dependencies few. A new dependency needs a reason in the pull request.

## Database

- Change the schema in the owning module's `schema.ts`, then run `pnpm db:generate` and commit
  the generated migration. Never edit a migration that has been merged.
- Migrations must apply to a database that already has data: add columns as nullable or with a
  default, backfill, then tighten.
- Heavy rebuilds (prices, visibility, search) are set-based SQL run as background jobs, never row
  by row inside a request.

## Tests

- Vitest. Unit tests sit next to the code (`*.test.ts`); database tests are named
  `*.integration.test.ts` and skip when `TEST_DATABASE_URL` is not set.
- Each integration test file gets its own database with
  `prepareTestDatabase(TEST_DATABASE_URL, '<unique_suffix>')` from `@muziris/db`, because suites
  run in parallel and empty their tables. Never point two files at the same suffix.
- Time-dependent logic takes `now: Date` as a parameter so tests control the clock.
- Pricing, tax, totals and access control get known-answer tables (`it.each`) covering
  boundaries and rounding.
- Test the behaviour a caller sees, not private helpers.
