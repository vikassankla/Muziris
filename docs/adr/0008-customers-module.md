# 0008: Customers, buyer users and addresses live in a customers module

- Status: proposed
- Date: 2026-10-28

## Context

Week 2 of the pilot plan needs customers: a hierarchy of parent companies and subsidiaries,
customer groups, buyer users linked to identity users, invitations, and addresses with India and
US rules (PIN code, GST state code, GSTIN, ZIP code). Access control (ADR 0006, proposed) scopes
storefront queries by access level and expects the customers module to supply the descendants
of a customer as an `SQL` select, so that it never reads customer tables. Identity owns accounts
and exposes `createUser`, `findUserByEmail` and `disableUser`; a module never touches another
module's tables (ADR 0001). Week 3's price lists and visibility build on customers and customer
groups.

## Decision

Customers is a new module, `modules/customers` (`@muziris/customers`), owning the tables prefixed
`customer_`: `customer_customer`, `customer_group`, `customer_buyer_user`, `customer_invitation`
and `customer_address`. The root table is `customer_customer` rather than `customer`, so the
prefix rule stays mechanical: every table the module owns starts with `customer_`.

- **Hierarchy.** `customer_customer.parent_id` refers to the same table. The database refuses a
  customer as its own parent. Longer cycles are refused by `setCustomerParent`, which takes a
  transaction-scoped advisory lock, so two crossing moves cannot each pass the check, and then
  checks that the new parent is not among the customer's descendants. A trigger was not used:
  drizzle-kit does not generate triggers, and hand-written SQL in a generated migration would be
  lost when the migration is regenerated. The descendant walk is a recursive CTE with
  PostgreSQL's `CYCLE` clause, so a cycle written around the module still cannot make a query
  run forever.
- **Access plugs in through `descendantCustomerIds(customerId)`,** which returns an `SQL` select
  of one uuid column without surrounding parentheses, as ADR 0006 expects.
- **Customer groups:** a customer is in at most one group (`group_id`, nullable).
- **Buyer users.** `customer_buyer_user` has the identity user's id as its primary key, with no
  foreign key to identity, so "buyer user id" is the same value in identity, access and here. A
  buyer user works for exactly one customer. Accounts are created or found only through
  identity's public interface (`createUser`, `findUserByEmail`), and admin accounts are refused.
- **Invitations.** A 256-bit random token goes in the emailed link; only its SHA-256 is stored,
  in a unique column. An invitation lasts seven days by default (one hour to 30 days) and can be
  accepted strictly before `expires_at`. Time logic takes `now`. At most one open invitation
  exists per customer and email (a partial unique index); sending another revokes the old one.
  Accepting creates the buyer account in identity, then claims the invitation with a conditional
  update and links the buyer user in one transaction. If that fails, the new account is
  disabled, so no unlinked account can sign in.
- **Addresses** are India or US only for the pilot. India: two-digit GST state code, six-digit
  PIN code not starting with 0, optional GSTIN whose first two digits equal the state code and
  whose check character is valid (Luhn mod 36). US: two-letter USPS state code, ZIP or ZIP+4.
  Input is normalised (`411 026`, lower-case GSTIN, `941051234`) and validated with zod; the
  database checks the same formats and the GSTIN's state prefix, but not the check character.
  A customer has at most one default billing and one default shipping address (partial unique
  indexes).
- **Scoping.** Storefront reads (`listCustomersForBuyer`, `findCustomerForBuyer`,
  `listAddressesForBuyer`, `listBuyerUsersForBuyer`) take the signed-in identity user's id and a
  reach (`my_customer` or `my_customer_and_subsidiaries`, from the buyer's access level). The
  query itself derives the buyer user's customer and its subtree, so a caller cannot pass in a
  customer it does not belong to. Admin functions are unscoped; the admin API checks the admin's
  permission before calling them.

## Consequences

- Access control can scope "my customer and subsidiaries" without reading customer tables, and
  price lists and visibility (week 3) can refer to customers and groups by id.
- Every hierarchy change is serialised by one advisory lock. Moves are rare admin actions, so
  this is cheap, but bulk imports of hierarchies should set parents at creation, which needs no
  lock.
- A person can be a buyer user of only one customer. An email that already has a buyer account
  cannot accept an invitation; the account must be linked with `linkBuyerUser` instead. If a
  buyer must later work for several customers, `customer_buyer_user` gains a composite key and
  the scope context gains the customer chosen for the session.
- If an invitation is revoked between the account being created and the invitation being
  claimed, a disabled account with that email remains, and the same email cannot be invited
  again until an admin deals with the account.
- Disabled customers, contacts (CRM), and countries other than India and the US are not in this
  decision. Adding a country means a new branch in the address schema and the database checks.
- Buyer users and invitations whose identity account is deleted are left behind, as with
  access assignments (ADR 0006). Accounts are disabled rather than deleted today.
