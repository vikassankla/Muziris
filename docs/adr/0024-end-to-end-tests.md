# 0024: End-to-end buyer journeys with Playwright

- Status: accepted
- Date: 2026-11-03

## Context

The week 5 plan asks for end-to-end buyer journeys before the pilot launch. Today:

- **Unit and component tests** (vitest, Testing Library) cover each screen against a mocked API.
- **Integration tests** cover the API and modules against PostgreSQL. This includes known
  answers for a whole checkout through the real tax tables.
- **Nothing runs the built apps, the real API and the database together in a browser.**

The hand test on Docker (2026-11-03) found ten problems the other tests could not. One example:
new products were invisible to buyers until a visibility build, and nothing said so. Each
journey was also slow to repeat by hand.

## Decision

Run a small set of buyer and admin journeys with **Playwright Test** against the built admin
app and storefront, the real API and a fresh PostgreSQL database.

### Where and how it runs

- **Package:** a workspace package `e2e/` (`@muziris/e2e`), with no product code.
- **Global setup:**
  - creates a database `muziris_e2e`, migrates it and runs `setup`;
  - starts the API, and serves both apps with `vite preview` behind their API proxies, so the
    `__Host-` cookies work as in production;
  - starts Mailpit as a CI service container. Tests read invitation links from its HTTP API.
- **Data:** fixtures call the module functions or the admin API to create what a journey
  needs (website, tax tables, catalog, prices, customer, buyer). The UI is only for the
  journey under test. Each test uses its own customer and buyer, so tests can run in parallel
  on one database.
- **Selectors:** roles and accessible names only, as the component tests use. No CSS
  selectors or test ids unless a control has no accessible name. If one is missing, that is an
  accessibility bug to fix.
- **Browser:** Chromium in CI. WebKit and Firefox can be run locally with `--project`.
- **CI:** a separate `e2e` job after `test`, with these settings:
  - a 10-minute limit;
  - one retry, and a trace kept when a test fails, uploaded as an artifact;
  - a test that passes only on retry counts as flaky and is fixed or quarantined within a
    week.

### The first journeys

1. **Invitation to order.**
   - An admin invites a buyer; the buyer opens the email link, sets a password and signs in.
   - The buyer sees only their catalog, adds lines by quick order and checks out on payment
     terms.
   - The buyer sees the order and its email. The admin confirms the order and sees it on the
     customer's Orders tab.
2. **Prices and tiers.** A buyer's cart shows the list price, then the tier price at 100, then a
   customer's contract price. Totals match the checkout known answers.
3. **Shopping list reorder.** A buyer saves a list, reorders from it, and is told about a line
   that is no longer visible.
4. **Catalog changes reach buyers.** An admin adds a product, the Products list says buyers do
   not see it yet, the admin builds visibility, and the buyer finds the product in search.
5. **Tax readiness.** On a new website, checkout refuses with the Tax screen's reason, the admin
   fixes the readiness items, and checkout succeeds.

### Not in this decision

- Card payments in the browser. The gateways' hosted fields need their test servers and
  network access, so their contract tests stay as they are.
- Visual regression, load testing and a cross-browser matrix in CI.

### As built

- **Order of start-up.** Playwright's `webServer` runs `e2e/src/prepare.ts` before the API: it
  drops and creates `muziris_e2e`, migrates it, runs the `setup` and `admin:create` commands as
  an install does, and seeds the shared world (website `main` in Maharashtra, three products,
  list prices, GST rates, shipping). The apps are built, then served by `vite preview`.
- **Ports.** API 4100, admin app 4180, storefront 4181, clear of the dev servers and Docker. The
  Vite configs read `MUZIRIS_API_TARGET` for their proxy, defaulting to the dev API on 4000.
- **Production settings where they matter.** The storefront runs persisted queries only
  (`STOREFRONT_ADHOC_QUERIES=deny`), and the browser keeps the `__Host-` cookies because the
  apps are on `localhost`.
- **One admin sign-in.** A setup project signs the administrator in once and shares the
  cookies, since sign-in is limited to 20 attempts per address in 10 minutes. Buyers sign in per
  test. Many more journeys will need that limit raised for this suite.
- **Journeys that change what buyers see run one at a time.** A visibility build is for the
  whole catalog, so journeys 3, 4 and 5 are in `catalog-changes.spec.ts` in serial mode, and no
  other journey builds visibility.
- **Tax readiness on the main website.** The storefront build serves one website, so journey 5
  uses a product of its own whose HSN code no rate covers, rather than a new website. The admin
  adds the rate on the Tax screen, and checkout goes through.
- **Shopping list reorder.** The withdrawn line is a product disabled after the list is saved.
  The list says it can no longer be ordered, and checkout leaves it out.
- **Not covered yet.** Journey 1 does not show that a buyer is kept out of another customer's
  catalog; visibility rules have no admin screens yet (status item 16).

## Consequences

- One new dev dependency, `@playwright/test`, and a browser download in CI (about 150 MB,
  cached).
- CI takes a few minutes longer. Integration and unit tests stay the main safety net;
  journeys are few and cover what only the whole system shows.
- Missing accessible names surface as test failures, which keeps the screens usable with
  assistive technology.
- The journeys double as the pilot's acceptance checklist, so the hand test shrinks to what
  needs judgement (layout, wording).
