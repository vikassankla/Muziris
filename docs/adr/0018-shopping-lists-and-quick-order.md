# 0018: Shopping lists, quick order and the checkout page

- Status: proposed
- Date: 2026-11-01

## Context

ADR 0016 placed orders from lines the caller sends and said Muziris has no cart: a buyer collects
products in a shopping list, or types them into a quick order (FR-CO-5). Neither exists yet, so
the storefront has no way to reach checkout. The requirements spec asks for:

- **Shopping lists:** many lists per buyer, lines with a unit and a note, rename, duplicate,
  share by access level, saved for later, and moving lines between lists.
- **Quick order:** paste SKUs and quantities, upload a CSV, SKU typeahead, then add to a list or
  go to checkout.
- **Access and visibility:** lists obey buyer access levels (FR-AC-3), and a hidden product
  cannot be added (FR-VI-4).

The buyer permissions `shopping_list.view` and `shopping_list.manage` already exist (ADR 0006).
The storefront API runs only persisted operations, and mutations must use POST behind the
trusted-origin guard (ADR 0014).

## Decision

### Shopping lists (new module `modules/shopping-lists`)

**Tables:**

- `shopping_list`: website, customer, owner (buyer user), name (1 to 100 characters), and
  created and updated times.
- `shopping_list_line`: list, position, product, unit code, quantity (numeric, at the unit's
  precision), an optional note (up to 500 characters), and created and updated times.
- One line per product and unit within a list. Adding the same product and unit again adds to
  that line's quantity.
- Limits: 100 lists per buyer user and 500 lines per list, checked in the module and by the
  database.

**Who sees a list.** Lists use the buyer's `shopping_list` access level, applied in the query
through `buyerScope`, as orders do:

- `own_records`: lists the buyer owns.
- `my_customer`: every list of the buyer's customer.
- `my_customer_and_subsidiaries`: the customer's lists and its subsidiaries' lists.

That is the "share by access level" in the spec: no list has its own sharing settings.
`shopping_list.manage` lets a buyer change any list they can see; a list belongs to one customer
and one website.

**What a list does:**

- Lists: create, rename, duplicate (into a list the buyer owns), delete.
- Lines: add (several at once), change quantity, unit or note, remove, and move to another list
  the buyer may manage (merging into an existing line).
- Each product must be visible to the buyer when it is added (FR-VI-4). Each quantity must fit
  the unit's precision and meet the product's minimum.
- A list stores no prices. The storefront shows the buyer's current price for each line, and
  marks a line whose product has since become hidden or unpriced as unavailable instead of
  dropping it.

**Not in the pilot:** saved for later, list notes beyond line notes, and customer part numbers.

### Quick order

Quick order stores nothing, so it is a storefront page plus one new query:

- **The query.** `productsBySkus(skus: [String!]!)` takes at most 500 SKUs. It returns the
  products the buyer may see, with their units and the buyer's price, and the SKUs it could not
  find. A hidden SKU and an unknown SKU look the same, as they do on the product page.
- **The page (`/quick-order`):**
  - Rows of SKU, quantity and unit, with typeahead from the existing search.
  - A paste box: one line per item, SKU then quantity, split by a tab, a comma or spaces, with an
    optional unit code third.
  - A CSV upload in the same format, with an optional header row, at most 500 rows, read in the
    browser only.
  - Every row is checked (found, visible, priced, quantity at the unit's precision) and its
    problems are shown on the row.
- **Two actions:** "Add to shopping list" (an existing list or a new one), and "Go to checkout".

### Checkout page (`/checkout`)

Checkout runs from a shopping list (`/checkout?list=<id>`) or from a quick order:

- **Quick order lines.** These are passed to the checkout page in memory, for this tab only. A
  reload sends the buyer back to quick order, and the page says so. No business data goes into
  browser storage.
- **The buyer picks:** billing and shipping addresses (from `viewer.customer.addresses`, with
  the default billing and default shipping addresses pre-selected) and an optional PO number.
- **The preview.** `checkoutPreview` runs again whenever an address or the lines change. It shows
  the lines, discounts, shipping, each tax and the total, or the refusal: prices changed, an
  unavailable line, tax problems (each shown on its line), or no payment method.
- **Placing the order.** "Place order" sends `placeOrder` with a UUID idempotency key, made once
  per attempt and sent again on a retry, and the preview's grand total. It then opens
  `/orders/<number>`. A refusal re-runs the preview and shows what changed.
- **The list.** Checkout from a list leaves the list as it is, because B2B buyers reorder from
  the same list. The confirmation offers to empty the list.

### API

- **Storefront GraphQL queries:**
  - `shoppingLists(first, after)`
  - `shoppingList(id)`, whose lines carry the product as the buyer sees it
  - `productsBySkus`
- **Storefront GraphQL mutations:** `createShoppingList`, `renameShoppingList`,
  `duplicateShoppingList`, `deleteShoppingList`, `addShoppingListLines`,
  `updateShoppingListLine`, `removeShoppingListLines` and `moveShoppingListLines`.
- **How mutations behave:**
  - They return the changed list, or a refusal with a stable code, as `placeOrder` does.
  - They run as persisted operations over POST only, behind the trusted-origin guard.
  - The storefront client gains a POST path for them. Queries keep using GET.
- **Admin:** a read-only `/admin/v1/shopping-lists?customerId=` for support staff, under
  `customer.view`. Admin screens for it come later.

## Consequences

- Buyers can reach checkout from the storefront. Together with ADR 0016 that completes the buyer
  journey the week 5 end-to-end tests need.
- A new module and migration. Shopping lists read catalog, visibility and pricing only through
  their public interfaces.
- No new dependencies: CSV parsing for quick order is a small function with known-answer tests.
- Checkout from a list re-checks everything at placing time (ADR 0016), so a list that has gone
  stale can never place an order at an old price.
- This touches access control (scoping by access level), so its pull requests need a second
  human reviewer under CLAUDE.md rule 4.
- Not in the pilot: saved for later, customer part numbers, and lists shared with named people.
