# 0011: Price lists and the combined price list live in a pricing module

- Status: proposed
- Date: 2026-10-29

## Context

Week 3 of the pilot plan needs price lists with customer and customer group fallback, and the
combined price build. The gate check for the week is that a buyer sees only their own catalog
and prices, so every price lookup must be scoped to one customer. The glossary defines a
**price list** ("a set of prices by product, unit, currency and minimum quantity") and a
**combined price list** ("the precomputed result of a customer's chain of price lists, used for
every price lookup").

CLAUDE.md requires money as `Money` minor units and quantities as exact decimals (ADR 0004),
one rounding at a documented step, known-answer tests for pricing, and heavy rebuilds as
set-based SQL run as background jobs, never row by row in a request. There is no job runner
yet: pg-boss is an open item. Customers (ADR 0008) own customer groups and the hierarchy;
catalog (ADR 0009) owns products and product units, priced "each product unit separately";
platform owns websites, each with one default currency. A module never reads another module's
tables (ADR 0001). Admin lists are paged (ADR 0010). The admin permissions
`price_list.view` and `price_list.manage` already exist (ADR 0006). The admin boards
`PriceLists` and `PriceListDetail` show one currency and one pair of active dates per price
list, its assignments, its prices with quantity tiers, the fallback chain, and a price preview
that says which price list was used, skipped or not reached.

## Decision

Pricing is a new module, `modules/pricing` (`@muziris/pricing`), owning the tables prefixed
`pricing_`. It depends on `@muziris/db`, `@muziris/money`, and the public interfaces of
`@muziris/catalog`, `@muziris/customers` and `@muziris/platform`. Admins edit price lists;
an explicit, set-based build turns them into combined price lists; every price lookup reads
only the combined price lists.

### Price lists and prices

- **`pricing_price_list`**: a name, one currency (ISO 4217, from `@muziris/money`), and
  optional active dates `active_from` and `active_until`, stored as `timestamptz` in UTC. A
  price list is active at an instant `t` when `active_from <= t < active_until`, a missing end
  being open. The database checks that `active_until` is after `active_from`. The currency
  cannot be changed after creation, because every price in the list is an amount in it; a
  different currency means a new price list. The admin sees a status derived from the dates
  and the clock (`scheduled`, `active`, `expired`); it is not stored.
- **`pricing_price`**: one row per price list, product, product unit and minimum quantity,
  with the amount as `bigint` minor units of the list's currency. A unique key covers
  `(price_list_id, product_id, unit_code, min_quantity)`. Several rows with different minimum
  quantities for one product and unit are its **tiers**.
  - The amount is read from a decimal string ("4.86") with `moneyFromDecimal` and no rounding
    mode: more decimals than the currency allows is refused, never rounded. Zero is allowed
    (free samples); negative amounts are refused, in code and in the database.
  - The minimum quantity is a decimal string read with catalog's `parseQuantity` at the
    product unit's precision and no rounding mode, stored as `numeric(18, 6)`. It must be
    greater than zero.
  - Before a price is written, catalog's `findProduct` must find the product, and the product
    must be sold in the product unit. There is no foreign key into catalog tables.

### Assignments and the fallback chain

- **`pricing_assignment`** puts a price list on a website for one target: a customer, a
  customer group, or the website itself, with a priority (a whole number from 1 to 1000,
  lowest first). Each target on a website holds a price list at most once and each priority
  at most once, so the order is total. A price list may have many assignments, on several
  websites. Its currency must be the website's default currency, checked through platform's
  `findWebsite`; customers and customer groups are checked through `findCustomer` and
  `findCustomerGroup`.
- **The chain** for a customer on a website is: the customer's own price lists by priority,
  then the price lists of the customer's group by priority, then the website's price lists by
  priority. Subsidiaries do not inherit their parent's price lists; a subsidiary that should
  share them is given the same assignments or the same customer group.
- **First price found wins, per quantity.** For a product, product unit, currency and
  quantity, walk the chain and take the first price list that is active and has a tier for
  the product and unit whose minimum quantity is at most the quantity; use its tier with the
  largest such minimum quantity. Example: a customer contract with only a "100 or more" tier
  prices 120 units, while 50 units fall through to the group or website price list. A price
  list with no price for the product, or no tier low enough, is skipped.
- **Rounding.** A price is a unit price and is never rounded: it is exactly the stored amount.
  The line amount in the preview is `multiply(unitPrice, quantity, 'half-up')`, rounded once,
  to the currency's minor unit. Orders (week 4) use the same step.

### The combined price list

- **`pricing_combined_price_list`** holds one row per distinct chain (`price_list_ids`, an
  ordered `uuid[]`, unique), so customers that share a chain share its combined price list.
- **`pricing_combined_price_list_target`** says which combined price list serves each
  website's customers with their own assignments, customer groups with assignments, and the
  website itself. A customer's row records the customer group the chain was built with.
- **`pricing_combined_price`** holds the result: for each combined price list, product,
  product unit, currency and minimum quantity, the winning amount, the price list it came from,
  and a validity interval `[valid_from, valid_until)`. The build splits time at every active
  date of the chain's price lists and works out the winners for each interval, so a price list
  starting or ending changes prices at that instant without a rebuild. Minimum quantities are
  every tier of every price list in the chain, so a lookup takes the row with the largest
  minimum quantity at most the quantity asked.
- **Lookup.** `findPrice` (admin preview) and `findPriceForBuyer` (storefront) read only the
  combined tables, in one query that also derives the customer's group through customers'
  `customerGroupMembership()`, an `SQL` select in the style of `descendantCustomerIds`. The
  buyer version takes the signed-in identity user's id and derives the customer inside the
  query through `reachableCustomerIds(userId, 'my_customer')`, so a caller cannot ask for
  another customer's prices. Lookup order: the customer's row, if it exists and was built with
  the customer's current group; otherwise the group's row; otherwise the website's row. A
  customer with its own row whose group has changed since the build gets **no price** (reason
  `needs_rebuild`) instead of a price from the wrong chain.
- **The build** (`rebuildCombinedPrices`) is set-based SQL, in one transaction: it takes a
  transaction-scoped advisory lock, so builds run one at a time; deletes every combined price
  list; inserts the distinct chains, the targets and the combined prices with one
  `insert ... select` each; and records the build. Lookups keep reading the previous build
  until the transaction commits, so a buyer never sees a half-built result. The statement
  timeout is raised for this transaction only. It is a full rebuild; the pilot's catalog and
  price lists are small enough. Building only the chains that changed is later work.
- **Freshness.** Every write to price lists, prices or assignments increments a change
  counter in `pricing_build_state`, in the same transaction; a build records the counter it
  read under a row lock. "Changes waiting for a build" is shown when the counter is higher than
  the built one. Changes to price lists reach buyers only through a build: this is the publish
  step an admin takes after editing. Changes made in other modules (a customer's group, a
  product unit a product stops being sold in) are not counted; the admin rebuilds after them.

### How a build is triggered

- **Now:** a synchronous admin action, `POST /admin/v1/pricing/build` (`price_list.manage`),
  and a CLI command, `pnpm --filter @muziris/api pricing:build`, for installs and scripts.
  Both run the same set-based build; the request waits for it. Nothing rebuilds on its own.
- **When the job runner lands:** price list writes enqueue a debounced build job with a
  singleton key, so a burst of edits causes one build; the admin action enqueues the same job
  and answers 202 with the build's id; time-based starts and ends need no job, because the
  validity intervals already carry them. The build function, the tables and the lookups do not
  change.

### Admin API

Under `/admin/v1/pricing`: reads need `price_list.view`, changes and the build need
`price_list.manage`. Price lists (list, create, read, rename and change dates, delete), their
prices (list by product and unit, add a tier, change its amount, delete it), assignments (list
by price list or by target, create, change priority, delete), the build (state, and run), and
a price preview for a customer, website, product, product unit and quantity. The preview
returns the price a buyer gets now from the combined price list, and a trail worked out from
the price lists as they are now, saying for each step of the chain whether it was used,
skipped, not reached (with the price it would give) or inactive. Lists are paged as in
ADR 0010. Refusals are RFC 9457 problems with the module's stable codes.

## Consequences

- Price lookups cost one indexed read and never compute a chain, so storefront browsing,
  search and checkout can price many lines cheaply.
- Admin edits are not live until a build. The admin app must show "changes waiting for a
  build" and offer the build next to the price list screens. A missing build is safe: buyers
  keep the previous prices.
- Moving a customer that has its own price lists to another customer group stops its prices
  until the next build. This is deliberate: no price is safer than a price from the wrong
  chain. Customers without their own price lists follow a group change at once, if the new
  group's chain was built.
- The build deletes and rewrites every combined price, and holds a lock that makes price list
  writes wait. With large catalogs this needs incremental builds and the job runner.
- The combined price table grows with chains, products, tiers and date intervals. The pilot is
  far below where that matters; measure before the cloud MVP.
- Customers and platform gain small public functions for this (`customerGroupMembership`,
  `findCustomerGroup`, `findWebsite`).
- Prices for a product that is disabled or no longer sold in a unit stay in the combined price
  list. Visibility (week 3) decides what a buyer may see; checkout checks the unit.
- Websites price in their default currency only. A website with several currencies picks the
  currency per request and passes it to the lookup; the tables already carry it.
- Price list hierarchy inheritance (a subsidiary using its parent's price lists), price
  formulas (cost plus margin), CSV import and export, and an activity history are not in this
  decision.
