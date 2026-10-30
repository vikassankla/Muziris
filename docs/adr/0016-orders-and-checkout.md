# 0016: Orders and checkout on payment terms

- Status: proposed
- Date: 2026-10-30

## Context

Week 4 of the pilot plan adds ordering: shopping lists, quick order, checkout with payment on
terms, flat-rate shipping, GST and US tax tables, orders with the order workflow, and emails. The
requirements spec fixes the rules checkout must keep:

- FR-CO-1: totals run in a fixed pipeline (line subtotals, line discounts, order discounts,
  shipping, shipping discounts, tax, grand total), each stage a pluggable provider.
- FR-CO-3: at place order, prices, visibility, stock and minimum quantities are checked again,
  and placing an order is idempotent.
- FR-CO-4: an order keeps its own copy of SKU, name, unit, price, discounts, tax and addresses.
- FR-CO-5: checkout starts from a shopping list, a quick order or an accepted quote.
- FR-WF-4: the order workflow has the steps new, confirmed, processing, completed and declined.

What exists: buyer prices (`findPricesForBuyer`, ADR 0011), buyer visibility
(`visibleProductIdsForBuyer`, ADR 0012), the workflow engine (ADR 0007), settings that resolve
from customer to global (ADR 0003), customer addresses for India and the US (ADR 0008), and the
buyer permissions `order.place` and `order.view` with access levels (ADR 0006). The glossary
says Muziris has no cart: a shopping list is what a buyer collects products in. Nothing has
product tax codes, payment terms or a seller tax registration yet.

The pilot sells in India and the US only. Selling to all countries is recorded as a later phase
in `docs/status.md`.

## Decision

A new `orders` module owns checkout and orders. Checkout is a function, not a stored record: it
takes lines (product, unit, quantity) and the buyer's choices, and computes the totals. Placing
an order runs the same function again inside a transaction and stores the result.

**Checkout input.** A checkout request holds the website, the buyer, the lines, the billing and
shipping address ids, an optional purchase order number and an idempotency key. Where the lines
come from is the caller's business: quick order sends them directly, a shopping list sends its
lines (shopping lists are their own module, next), and an accepted quote later sends lines with
locked prices. The orders module never reads another module's tables.

**Totals pipeline.** `computeTotals` runs the FR-CO-1 stages in order, each behind an interface:

| Stage              | Pilot provider                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| Line subtotals     | The buyer's price from pricing, times the quantity, rounded once half-up    |
| Line discounts     | None (the stage exists and returns no adjustments)                          |
| Order discounts    | None                                                                        |
| Shipping           | Flat rate per website, from the `shipping.flat_rate` setting                |
| Shipping discounts | None                                                                        |
| Tax                | A `TaxProvider`; the GST and US table engine is ADR 0017, in its own module |
| Grand total        | The sum of the above, all in the website's currency                         |

Every stage works in `Money` and returns its lines and any adjustments with a reason, so an
order can show how its total was reached. Rounding happens once per stage, at the step each
provider documents.

**Checking again at place order.** In one transaction, `placeOrder`:

1. returns the existing order when the buyer already used this idempotency key (a unique key on
   buyer and key, so a double click never creates two orders);
2. checks the buyer holds `order.place` for the customer;
3. checks each product is enabled and visible to the buyer, each unit is one the product is
   sold in, and each quantity fits the unit's precision and the price's minimum quantity;
4. prices every line again, and refuses with `prices_changed` when the grand total differs from
   the one the buyer saw (the request carries it), so the buyer reviews the new total;
5. stores the order, its lines, tax lines and address copies, and starts the order workflow.

Stock is not checked: the pilot has no inventory. A refusal names the lines it is about.

**What an order keeps.** Order lines copy SKU, product name, unit code and name, quantity, unit
price, line subtotal and the tax code. Tax lines copy each tax's name, rate and amount. The
billing and shipping addresses are copied, with the customer's name and tax id (GSTIN). Orders
keep product and customer ids for links and reports, but never read through them to show an
order. An order is immutable once placed; only its workflow step changes.

**Order numbers.** One PostgreSQL sequence per installation, shown as a prefix plus six digits
(`MZ-000123`). The prefix is a website setting. Ids stay UUIDs; the number is for people.

**Payment on terms.** The payment term (days, for example 30 for net 30) is a setting resolved
customer, customer group, website, organization, as ADR 0003 does. The order copies the term
and its due date is placed-at plus the term in the website's time zone. Card and bank payments
(Stripe, Razorpay in test mode) come in a later ADR with a payments module; an order records
`payment_method = 'terms'` until then.

**Order workflow.** `order_processing` with steps `new` (initial), `confirmed`, `processing`,
`completed` (final) and `declined` (final). Transitions: `confirm` (new to confirmed),
`decline` (new to declined), `start_processing` (confirmed to processing) and `complete`
(processing to completed). Admins with `order.manage` run them; placing the order starts the
workflow as the buyer. Emails subscribe to the transition log when the email work lands; no
action calls an outside service.

**Who sees an order.** Buyers read orders through `buyerScope(access, 'order.view', ...)` with
the order's customer and the buyer who placed it, inside the query (ADR 0006). Admins read and
move orders with `order.view` and `order.manage`.

**APIs.** The storefront API gains its first mutations, sent as persisted operations by POST as
ADR 0015 planned: `checkoutPreview` (a query: totals without saving), `placeOrder` (a
mutation), and the queries `orders` and `order(number)`. The admin API gains
`/admin/v1/orders` (list, view, transitions). The storefront and admin screens follow the
module in their own pull requests.

## Consequences

- Shopping lists, quick order and accepted quotes all reach an order through one function, so
  the checks and the totals are written once.
- Checkout has no stored state to expire or clean up. The cost is that preview and place order
  each price the lines; `findPricesForBuyer` prices up to 500 lines in one statement.
- Changing the order of the totals stages, or adding a discount provider, is a change in one
  place. Discounts and promotions are not built in the pilot.
- Tax is a separate decision (ADR 0017) and module, with India GST and US state tables. The
  orders module depends only on the `TaxProvider` interface.
- Catalog gains a tax code on products (HSN or SAC in India, a tax category in the US), and the
  website gains its tax registration (GST state and GSTIN), because tax needs both.
- This changes pricing at checkout and adds payment on terms, so its pull requests need a second
  human reviewer under CLAUDE.md rule 4.
- No stock checks, no partial shipments, no order edits after placing, and no buyer
  cancellation in the pilot. A buyer who wants to cancel asks the seller, who declines the order
  while it is new.
