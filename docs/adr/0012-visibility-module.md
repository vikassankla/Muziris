# 0012: Catalog visibility lives in a visibility module

- Status: proposed
- Date: 2026-10-29

## Context

Week 3 of the pilot plan needs catalog visibility. The week's gate check is that a buyer sees
only their own catalog and prices; pricing (ADR 0011) is the prices half, and visibility is the
catalog half. PostgreSQL search, the GraphQL storefront API and storefront browsing come next
in the same week and must filter every product list through visibility.

Catalog (ADR 0009) owns products, with a status (`enabled` or `disabled`) and at most one
category, and the category tree. Customers (ADR 0008) own customer groups and the hierarchy,
and export `SQL` selects (`reachableCustomerIds`, `customerGroupMembership`) so other modules
can scope queries without reading customer tables. Platform owns websites. A module never reads
another module's tables (ADR 0001). CLAUDE.md requires every query that returns buyer data to
be scoped to the caller in the query itself, and heavy rebuilds (prices, visibility, search)
to be set-based SQL run as background jobs, never row by row in a request. There is no job
runner yet (pg-boss is an open item); pricing builds on an admin action and a CLI command, with
a change counter that says when changes are waiting for a build. Admin lists are paged
(ADR 0010). There is no admin permission for visibility yet (ADR 0006).

## Decision

Visibility is a new module, `modules/visibility` (`@muziris/visibility`), owning the tables
prefixed `visibility_`. It depends on `@muziris/db` and the public interfaces of
`@muziris/catalog`, `@muziris/customers` and `@muziris/platform`. Admins edit visibility rules;
an explicit, set-based build turns them into the products and categories each buyer may see;
every storefront read filters through the build's result.

### Rules

- **`visibility_rule`** says that, on one website, one **subject** (a product or a category) is
  `visible` or `hidden` for one **target**: a customer, a customer group, or the website itself
  (every buyer on it). Each subject and target on a website has at most one rule (a unique key),
  so a rule is changed, not stacked. Products, categories, websites, customers and customer
  groups are checked through their modules' public interfaces before a rule is written; there
  are no foreign keys into other modules' tables.
- **Without any rule, an enabled product is visible.** A catalog is open by default, and an
  admin narrows it, for example by hiding a category on the website and showing it to one
  customer group. A website that should be closed by default hides its top-level categories.
- **Disabled products are never visible**, whatever the rules say.

### Fallback order

For a product and a customer on a website, the levels are tried in the order pricing uses
(ADR 0011): the **customer**, then the customer's **customer group**, then the **website**.
The first level with a rule that applies decides. Within a level:

1. a rule on the product itself applies first;
2. otherwise a rule on the product's category;
3. otherwise a rule on the nearest category above it, walking up the tree.

If no level has a rule that applies, the product is visible. A **category** is decided the same
way, starting at step 2 with the category itself. Subsidiaries do not inherit their parent's
rules; a subsidiary that should share them is given the same rules or the same customer group.

Examples, for a product in Bearings, under Power transmission:

- The website hides Power transmission; the customer's group shows Bearings. The group level
  comes before the website level, so the product is visible to the group, hidden to everyone
  else.
- The website hides the product itself; the customer's group shows Bearings. The group level
  decides first: visible. A more specific target beats a more specific subject.
- The customer's group hides Power transmission and shows Bearings. Within the group level the
  nearer category wins: visible.

The rule is written once in plain code (`resolveVisibility`) for the admin preview and the
known-answer tests, and once in the build's SQL; the same known-answer tables run through both.

### The precomputed result

- **`visibility_context`** holds one row per set of rules that can apply to a buyer: a
  **default** row (no rules), one per website with website rules, one per customer group with
  rules on a website (its rules, then the website's), and one per customer with rules on a
  website (its rules, its group's, then the website's). A customer's row records the customer
  group it was built with.
- **`visibility_visible_product`** and **`visibility_visible_category`** hold the product and
  category ids each context may see. Only visible rows are stored, so an unbuilt or missing
  context shows nothing: the result fails closed.
- **The build** (`rebuildVisibility`) is set-based SQL in one transaction, as pricing's is: a
  transaction-scoped advisory lock so builds run one at a time, a raised statement timeout for
  the transaction only, a delete of every context, then one `insert ... select` each for the
  contexts, the visible categories and the visible products. Category ancestry is a recursive
  CTE over catalog's `categoryParents()` with the `CYCLE` clause; product status and category
  come from catalog's `productCategoryAndStatus()`; a customer's group comes from customers'
  `customerGroupMembership()`. Readers keep the previous result until the build commits.
- **Freshness.** Every write to rules increments a change counter in
  `visibility_build_state`, in the same transaction; a build records the counter it read under
  a row lock, so "changes waiting for a build" is exact for rule changes. Changes in other
  modules are not counted: a new or newly enabled product, or a moved category, waits for the
  next build (and is invisible until then, which is the safe side). A product disabled after
  the build disappears at once, because every read also checks catalog's status live.

### How a build is triggered

- **Now:** a synchronous admin action, `POST /admin/v1/visibility/build`
  (`visibility.manage`), and a CLI command, `pnpm --filter @muziris/api visibility:build`.
  Both run the same build and wait for it. Nothing rebuilds on its own.
- **When the job runner lands:** rule writes and catalog changes enqueue a debounced build job
  with a singleton key; the admin action enqueues the same job and answers 202. The build
  function, the tables and the reads do not change.

### How search and the storefront use it

- **`visibleProductIdsForBuyer({ buyerUserId, websiteId })`** and
  **`visibleCategoryIdsForBuyer(...)`** return an `SQL` select of one uuid column
  (`product_id` or `category_id`) without surrounding parentheses, like
  `reachableCustomerIds`. The buyer user's customer is derived inside the select through
  `reachableCustomerIds(buyerUserId, 'my_customer')`, so a caller cannot ask for another
  customer's catalog; a user id that is not a buyer user selects nothing. Search and the
  storefront put it in the query that lists products (`product_id in (...)`), never filter
  afterwards.
- The context is chosen as pricing chooses a combined price list: the customer's own row if it
  exists and was built with the customer's current group; otherwise the group's row on the
  website; otherwise the website's row; otherwise the default row. A customer with its own row
  whose group has changed since the build sees **nothing** until the next build, rather than a
  catalog built from the wrong group.
- `visibleProductIds({ customerId, websiteId })` is the same select for a customer chosen by an
  admin, for the admin preview; it is not for storefront use.

### Admin API and permissions

Under `/admin/v1/visibility`: rules (list with filters, create, change, delete), the build
(state, and run), a preview that explains one product or category for a customer on a website
(the decision worked out from the rules as they are now, the deciding rule, and the answer the
last build gives), and the visible products of a customer on a website from the last build.
Lists are paged as in ADR 0010; refusals are RFC 9457 problems with the module's stable codes.
Two admin permissions are added to access control: `visibility.view` and `visibility.manage`.
Visibility decides what buyers may see, which is access scoping, so it is not folded into
`product.manage`.

## Consequences

- A storefront product list costs one extra semi-join against an indexed table, and never
  walks rules or the category tree, so search and browsing stay cheap.
- Rule edits are not live until a build, like price list edits. The admin app must show
  "changes waiting for a build" next to the visibility screens.
- New and newly enabled products, and category moves, need a build before buyers see their
  effect. Until the job runner exists, an admin runs the build after catalog work.
- The result table grows with contexts times visible products. Customers with their own rules
  each get a full copy; the pilot is far below where that matters. Storing only the
  differences from the website's row is later work, measured before the cloud MVP.
- Catalog gains two small public functions (`productCategoryAndStatus`, `categoryParents`);
  access gains two permissions, which the built-in administrator role holds at once.
- Visibility per product unit, per price (hide products with no price), per subsidiary
  inheritance, and scheduled rules are not in this decision. Checkout must still refuse a
  product the buyer cannot see; it will use the same select.
