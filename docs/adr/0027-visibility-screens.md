# 0027: Visibility rule screens in the admin

- Status: accepted
- Date: 2026-11-04

## Context

Visibility (ADR 0012) decides which products and categories each buyer sees, from rules on a
website: a product or a category is visible or hidden for a customer, a customer group or the
whole website. The API under `/admin/v1/visibility` already covers rules (list with filters,
create, change, delete), the build (state and run), a preview that explains one product or
category for one customer, and the visible products of a customer from the last build. Since
the job runner (ADR 0025), every rule write queues a build.

The admin app has no screen for any of it. The only sign of visibility is the Products list's
banner, "Buyers do not see catalog changes yet", with **Build visibility now** (status item
16). The hand test listed admin screens for visibility rules as a follow-up.

Two gaps in the API matter for a screen:

- **Ids only.** A rule carries `subjectId` and `targetId`, but no SKU or names.
- **No search by name.** Rules can be filtered by subject and target ids, not found by a
  product's SKU or a customer's name.

There is no design board for visibility.

## Decision

### Screens

- **`/visibility`**, in the sidebar under Catalog for `visibility.view`. It works on the
  website chosen in the switcher (ADR 0021), like the Tax screen.
  - **The build banner** at the top, as on the price list screens (ADR 0022): rule changes or
    catalog changes waiting for a build, a build queued or running, or the time of the last
    build. **Build now** for `visibility.manage`.
  - **Rules**, a paged table: **Subject** (a product's SKU and name, or a category's path),
    **For** ("Everyone on <website>", a customer group's name, or a customer's name),
    **Visibility** (a Visible or Hidden badge) and **Changed**. Filters for the subject kind
    (product or category) and the target kind (website, customer group, customer).
  - **New rule**, a sheet for `visibility.manage`: the subject (a product picked by SKU or
    name, or a category from the tree), the target (everyone on the website, a customer group,
    or a customer, each picked by name) and Visible or Hidden. A rule for a subject and target
    that already has one is refused by the API (one rule per pair); the sheet says so and
    offers to change that rule instead.
  - Each row can switch between Visible and Hidden, and be deleted after a confirmation, for
    `visibility.manage`.
- **Check a buyer's view**, a sheet opened from the Visibility screen. It takes a customer and
  a product or category, and shows the preview's answer: visible or hidden, the deciding rule
  ("Hidden by the rule on Power transmission for Key accounts") or "no rule: visible by
  default", and what the last build gives. When the two differ, it says the change waits for a
  build.
- **Entry points.** The product page and the customer page each gain a small Visibility card
  with the rules on that product or for that customer on the website, linking to the
  Visibility screen filtered to them.
- **Permissions.** Reads need `visibility.view`; every change needs `visibility.manage`.
  Without it, the screens are read-only.

### API additions

- **Names beside ids.** Rule lists and single rules gain `subjectSku` and `subjectName`, and
  `targetName`, looked up for the page at once through catalog (`findProductsByIds`, and the
  category names it already lists) and customers (`customerNames`, `customerGroupNames`), as
  the price list screens did (ADR 0022). A subject or target that no longer exists shows its
  id with a null name.
- **Search.** `GET /admin/v1/visibility/rules` gains `q`: a product SKU or name, or a customer
  or customer group name. It matches ids from the owning modules first, then filters rules by
  them, so visibility still never reads another module's tables.

Nothing changes in the rules, the fallback order, the build or the storefront reads.

### Not built

- **Bulk rules**, such as hiding many products at once, or a CSV import of rules.
- **The list of products a customer sees.** The API has it from the last build; a screen for
  it waits until there is a use for it beyond the preview.
- **Rule history.** There is no activity log yet.

## Consequences

- Admins can narrow a catalog without the API by hand, and check what one buyer sees before
  telling them.
- Visibility decides what buyers may see, which is access scoping, so the pull request needs a
  second human review under CLAUDE.md rule 4.
- The rule list costs one lookup per page in catalog and customers for the names.
- A journey checks the screens end to end: hide a category from a customer group, build, and
  see the product leave that group's storefront while another customer still sees it.
