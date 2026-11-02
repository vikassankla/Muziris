# 0023: Tax screens and product tax codes in the admin

- Status: proposed
- Date: 2026-11-02

## Context

The tax engine (ADR 0017) charges GST and US sales tax from tables, and refuses checkout with
`tax_problems` when a product has no tax code, no rate covers it, or the website has no
registration. The tables and codes are entered only through the API:

- `/admin/v1/tax` covers:
  - registrations per website: the GSTIN, or US permits per state;
  - GST rates by HSN or SAC prefix;
  - US rates by state and ZIP prefix, with a CSV import;
  - customer exemption certificates.
- Catalog's product routes accept `hsnSacCode` and `usTaxCategory`, but the product page in
  the admin app has no fields for them.

So no website can take an order until someone calls the API by hand. Nothing tells an admin
what is missing before a buyer meets the refusal.

There is no design board for tax. Four choices in ADR 0017 are marked for a tax adviser to
confirm; these screens change none of them.

## Decision

### Screens

**`/tax`**, in the sidebar under Settings for `tax.view`. It works on the website chosen in the
switcher (ADR 0021) and shows the tabs for that website's country:

- **Readiness**, the first tab. A checklist of what would refuse checkout today. Each item
  links to where it is fixed:
  - **Registration:** India needs a GSTIN; the US needs at least one permit.
  - **Missing tax codes:** enabled products with no HSN or SAC code (India). This shows the
    count and the first 50, linked to the products list filtered to them.
  - **Codes no rate covers today:** HSN or SAC codes used by enabled products that no GST rate
    covers (India).
  - **States without a rate:** states with a permit and no state rate (US).
- **Registration:**
  - **India:** the GSTIN, which the API already checks for format, state code and check
    character. Its state comes from the first two digits and is shown.
  - **US:** the permit per state, with add and remove.
- **Rates:**
  - **India:** GST rates by HSN or SAC prefix, with dates. Overlapping periods are refused, as
    the API already does.
  - **US:** rates by state and ZIP prefix, with dates and "shipping taxable", plus the
    existing CSV import. The import shows the per-row errors it returns.
- **Exemptions (US):** certificates by customer and state, with number and expiry. The customer
  detail page gains the same list for that customer.

Changes need `tax.manage`; without it every tab is read-only.

### Product tax codes

The product page's General tab gains a Tax section:

- **HSN or SAC code.** Shown when the organization has an India website. It is checked as
  catalog checks it (4, 6 or 8 digits, or 6 digits starting 99). It shows the GST rate that
  covers the code today, or "no rate covers this code".
- **US tax category** (general or exempt). Shown when there is a US website.

The products list gains a filter for missing tax codes. The admin products list API gains
`missingTaxCode=true` (catalog), with no other change.

The price list CSV import (ADR 0022) does not set tax codes. A product CSV import is not in
the pilot.

### API additions

- **`GET /admin/v1/tax/readiness?websiteId=`** (`tax.view`). It returns the checklist above as
  data: each item with a stable code, a count and up to 50 examples.
  - The API composes the answer: the tax module answers for registrations, rates and states.
  - Catalog answers for enabled products, through a new function in its public interface.
    That function lists codes in use, and products without one.
- **`missingTaxCode`** on the catalog products list.

Nothing else changes in the tax engine, its rates or its refusals.

## Consequences

- An admin can make a website ready to sell and see what is still missing before a buyer
  does.
- The readiness check works on today's date. A rate that ends next week is not flagged until
  it has ended; expiring rates are a later addition.
- **Second reviewer.** This touches tax, so its pull requests need a second human reviewer
  under CLAUDE.md rule 4. The four **(check)** items in ADR 0017 still need the tax adviser
  before go-live.
- Not in this ADR:
  - tax reports (GSTR-1, state filings);
  - e-invoicing (IRN);
  - a rate service for US rooftop rates;
  - reverse charge;
  - importing tax codes for products in bulk.
