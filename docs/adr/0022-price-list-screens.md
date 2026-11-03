# 0022: Price list screens in the admin

- Status: proposed
- Date: 2026-11-02

## Context

Pricing (ADR 0011) has a full admin API under `/admin/v1/pricing`:

- price lists, with their prices and tiers;
- assignments to customers, customer groups and websites;
- the combined price build;
- a price preview with its trail.

The admin app has no screen for any of it. Today a buyer sees "Price on request" until
someone calls the API by hand.

The PriceLists and PriceListDetail boards in `docs/design/admin` show the screens. They assume
data the API does not return:

- **Ids only.** Prices carry product ids and assignments carry target ids, but no SKUs,
  product names or customer names.
- **No search.** Prices cannot be found by SKU or name.
- **No CSV.** Prices cannot be imported or exported.
- **No history.** There is no import history and no activity log.

The pilot catalogue is a few thousand products, so prices are entered in bulk or not at all.

## Decision

### Screens

- **`/price-lists`** follows the PriceLists board:
  - name, currency, active dates, status (scheduled, active or expired), the price count, and
    where it is assigned;
  - filters for currency and status;
  - "New price list" (a sheet: name, currency, optional dates).
- **`/price-lists/$priceListId`** follows PriceListDetail:
  - **Prices tab:**
    - one row per product and unit, with its tiers below it;
    - search by SKU or product name, and a unit filter;
    - "Add price" (product picker, unit, minimum quantity, amount), with editing and deleting
      in place;
    - Import CSV and Export CSV.
  - **Assignments tab:** each website, customer group or customer the list is assigned to,
    with its priority. An admin can add an assignment, change its priority or remove it.
  - **The fallback chain panel** shows where this list sits for a chosen customer.
  - **A rename and dates sheet**, and delete. Deleting is refused while the list has
    assignments.
- **Price preview** is a sheet, opened from both screens. It takes a customer, website,
  product, unit and quantity, and shows the final unit price, the line total "before tax",
  and the trail (used, skipped, not reached, inactive), as the board does.
- **The build banner.** Price changes reach buyers only after a build (ADR 0011). Both screens
  show "N changes waiting for the price build" and, with `price_list.manage`, a "Build prices
  now" button. Since the job runner (ADR 0025), each change queues a build, and the banner says
  the build is queued or running instead of offering the button.
- **Permissions.** Reads need `price_list.view`, and every change needs `price_list.manage`, as
  the API already checks. The sidebar item appears for `price_list.view`.

### API additions

**Names beside ids.** The API composes them; pricing still never reads other modules' tables
(ADR 0001):

- Prices gain `sku` and `productName`, from a new batch lookup in catalog's public interface,
  `findProductsByIds` (at most 200 ids, the page size).
- Assignments gain `targetName` and `websiteName`. Customer and customer group names come from
  new batch lookups in customers, and website names from `listWebsites`.

**Search.** `GET .../prices` gains `q`:

- An exact SKU match, or a match from the search module's admin search (`searchProducts`, the
  one behind `/admin/v1/search/products`), gives at most 1,000 product ids.
- Pricing then filters its prices to those ids.
- Paging stays as in ADR 0010.

**CSV import:** `POST /price-lists/:priceListId/prices/import` (`price_list.manage`).

- **Format.** UTF-8, at most 2 MB and 10,000 rows. The columns are `sku`, `unit`,
  `min_quantity` and `price`, a header row is required, and other columns are refused.
- **Rows are checked as one price would be.** The SKU must exist, the product must be sold in
  that unit, and the quantity and amount are read at their precision with no rounding
  (ADR 0011).
- **All or nothing by default.** If any row is invalid, nothing is written. The answer lists
  each invalid row, with its number and a stable code (`unknown_sku`, `unit_not_sold`,
  `invalid_quantity`, `invalid_amount`, `duplicate_row`).
- **`skipInvalid=true`.** This writes the valid rows and returns the skipped ones. The screen
  offers it after a refused import, showing the board's "N updated, M skipped" message and
  "Download skipped rows".
- **Upserts.** A row adds or replaces the price for its product, unit and minimum quantity, in
  one transaction. Prices not in the file are left alone; the import never deletes.
- **One change for the build.** An import counts as a single change for the build.

The tax module's US rate import already parses CSV; that parser moves to a shared helper in
`packages/` rather than being copied.

**CSV export:** `GET /price-lists/:priceListId/prices.csv` (`price_list.view`).

- It writes the same four columns, ordered by SKU, unit and minimum quantity, so an export can
  be edited and imported again.
- A cell starting with `=`, `+`, `-` or `@` is prefixed with `'`, so a spreadsheet does not run
  it as a formula.

### Not built

- **The board's "vs. US list price" column.** It needs a second chain lookup per row.
- **Import history and the Activity tab.** There is no activity log yet.
- **Price formulas.** For example, list price minus 10%.
- **Subsidiaries inheriting price lists.**

### As built

Where the build differs from the plan above, or settles something it left open:

- **The CSV package** is `packages/csv` (`@muziris/csv`): RFC 4180 quoting, a fixed header in
  any letter case, and a writer that prefixes `'` to a cell starting with `=`, `+`, `-`, `@`, a
  tab or a carriage return. The import strips that `'` again, so an export imports unchanged.
  The US tax rate import uses the same parser, so its cells may now be quoted.
- **Search** uses `searchProductIds` (the admin search statement, up to 1,000 ids) plus an
  exact SKU lookup in catalog, because the search index may not hold a new product yet.
- **The 2 MB limit** applies to the import route alone; every other body keeps
  `MAX_BODY_BYTES`.
- **Import answers.** A refused file is 422 `price_import_invalid_file`; refused rows are 422
  `price_import_invalid_rows` with `rows: [{row, sku, code, message}]`. A success answers
  `{added, updated, skipped}`. An empty `min_quantity` means 1. The log records the counts,
  never prices.
- **Names beside ids** come from `findProductsByIds`, `customerNames` and
  `customerGroupNames`. A price whose product is gone shows its id, and is left out of the
  export.
- **Status filter.** The API filters price lists by currency only; the status (worked out from
  the dates for now) is filtered on the page.
- **Delete** is offered only while a price list has no assignments; the API itself still
  deletes a list with its assignments.
- **Dates** are picked as days in the top bar website's time zone: from the start of the first
  day to the end of the last.
- **Not built:** the fallback chain panel on the price list page (the price preview shows the
  chain for a chosen customer instead), a category filter, and the customer picker searching
  beyond the first 200 customers.

## Consequences

- An operator can load and maintain prices from a spreadsheet, check what a buyer will pay,
  and publish it with one button.
- Catalog and customers gain batch lookups by id. They also close the open item "buyer users
  carry user ids only" for prices, and later screens can reuse them.
- CSV parsing lives in one place for prices and tax rates.
- **Second reviewer.** This touches pricing, so its pull requests need a second human
  reviewer under CLAUDE.md rule 4.
- Since the job runner (ADR 0025), price changes reach buyers within seconds without an
  admin; the button stays for a build after changes made outside the admin API.
