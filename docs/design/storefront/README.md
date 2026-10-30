# Storefront design boards

These are the storefront mock-ups for week 3 item 5 (storefront browsing), made in Claude Design
on 2026-10-30 and kept as the reference for `apps/storefront`. Each `*.dc.html` file is one
board. `canvas.json` names the boards and places them on the canvas. `muziris.css` is the admin
design system's copy, unchanged, and `storefront.css` adds the storefront's layout classes on top
of it. The storefront uses the same tokens and components as the admin app; it adds no design
system of its own.

The boards load a `support.js` runtime that is not included, so they do not render on their
own. To read them, look at the markup, the two stylesheets and the data in each board's script.
They are design data only.

## Boards and routes

| Board         | Route in `apps/storefront`                  | Notes                                       |
| ------------- | ------------------------------------------- | ------------------------------------------- |
| Main          | `/c/$categoryId` (and `/` for all products) | Category list with the buyer's prices       |
| ProductDetail | `/p/$sku`                                   | Price for a unit and quantity (interactive) |
| Search        | `/search?q=`                                | Results by match tier, then SKU             |
| SignIn        | `/sign-in`                                  | Default, failed, session ended              |
| States        | every screen                                | Loading, empty, no price, not found, error  |
| Mobile        | the same routes at phone width              | Rows become cards, categories in a menu     |

## Rules the boards follow

- **Signed-in buyers only.** Every page but sign-in needs a buyer session (ADR 0014). Guest
  browsing is later work.
- **One look for a missing and a hidden product.** "We can't find that product" serves both, as
  the API answers `null` for both.
- **Prices** are the buyer's prices, from `Product.price`, in the website's currency, formatted
  for the website's locale (en-IN: ₹1,12,500.00), excluding GST. A product with no price shows
  "Price on request", never ₹0.
- **Quantities** are whole numbers or decimals at the unit's `precision`, checked before the
  price is asked for.
- **Errors** show the request id as a reference and no internal detail.
- Rows link by SKU, prices use tabular figures, touch targets are at least 44 px on the phone
  board, and the dark theme is the admin's (each board has a `dark` tweak).

## Gaps between the boards and the API

- **Quantity breaks.** ProductDetail shows the next break ("From 100 boxes: ₹89.00 per box"). The
  API prices one quantity at a time and does not list the breaks. Adding a `priceBreaks(unitCode)`
  field is an additive schema change (ADR 0014); until then the app shows the price for the
  quantity entered and leaves out the next-break line.
- **Counts.** Lists page by SKU with `nextAfter` and have no total, so the boards say "Showing 10
  products", not "1 to 10 of 240".
- **Product images** are not in the catalog yet (ADR 0009), so the boards have none.
- **Ordering** (shopping lists, quick order, checkout) is week 4; the boards have no cart.
