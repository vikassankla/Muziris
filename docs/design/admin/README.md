# Admin design boards

These are the admin mock-ups from Claude Design, exported on 2026-10-28, kept unchanged as the
reference for `apps/admin`. Each `*.dc.html` file is one board. `canvas.json` names the boards
and places them on the canvas. `muziris.css` holds the shared tokens and utility classes.

The boards load a `support.js` runtime that is not included, so they do not render on their
own. To read them, look at the markup, `muziris.css` and the data in each board's script.
They are design data only. The tokens from `muziris.css` (light and dark) live in
`apps/admin/src/index.css` under shadcn/ui names.

## Boards and routes

| Board                                  | Route in `apps/admin`                   | State                     |
| -------------------------------------- | --------------------------------------- | ------------------------- |
| Main (home dashboard)                  | `/`                                     | Built without widgets     |
| Sidebar, Topbar, CommandPalette        | the signed-in layout                    | Built                     |
| SignIn                                 | `/sign-in`                              | Built, no two-factor      |
| Customers                              | `/customers`                            | Built                     |
| CustomerDetail                         | `/customers/$customerId?tab=…`          | Built (API tabs)          |
| AddressForms                           | sheet on the customer's Addresses tab   | Built                     |
| CustomerGroups                         | `/customer-groups`                      | Built                     |
| Products                               | `/products`                             | Built                     |
| ProductDetail                          | `/products/$productId`                  | Built (General tab)       |
| Categories                             | `/categories`                           | Built                     |
| ProductUnits                           | `/product-units`                        | Built                     |
| AdminRoles                             | `/admin-roles`, `/admin-roles/$roleId`  | Built                     |
| BuyerRoles                             | `/buyer-roles`, `/buyer-roles/$roleId`  | Built                     |
| States                                 | used on every screen                    | Built                     |
| Tokens                                 | `apps/admin/src/index.css`, `format.ts` | Built                     |
| Orders, OrderDetail, RFQs, QuoteEditor | none                                    | Designed, waiting on APIs |
| PriceLists, PriceListDetail            | none                                    | Designed, waiting on APIs |
| Websites, Settings                     | none                                    | Designed, waiting on APIs |

The pull request that built these screens lists where the app deliberately differs from the
boards, mostly where the API has no matching data yet: counts, search, totals, activity
history.
