# 0006: Access control lives in its own module

- Status: proposed
- Date: 2026-10-27

## Context

Admin users need roles that hold permissions, and every admin API route must check one. Buyer
users need buyer roles, where each permission carries an access level (own records, my
customer, my customer and subsidiaries), and every query that returns buyer data must be scoped
to that level in the query itself (CLAUDE.md, Security). Identity already knows who a person is
and whether they are signed in; its schema notes that access control links to identity users by
id. Customers, and so the customer hierarchy, arrive in a later module.

## Decision

Access control is a new module, `modules/access` (`@muziris/access`), owning the tables
prefixed `access_`. It is not part of identity.

- Permissions are declared in code as typed `as const` catalogues, one for admins and one for
  buyers. The database stores permission keys as text checked for shape only, so adding a
  permission needs no migration. Stored keys that are no longer in the catalogue are ignored on
  read, so removing one fails closed.
- Admin roles hold sets of admin permissions and are assigned to admin users. The built-in
  `administrator` role grants every permission, including ones added later, through a
  `grants_all_permissions` flag instead of stored rows. Built-in roles cannot be edited or
  deleted, and the last holder of `administrator` cannot lose it.
- No one can grant what they do not hold: creating or editing a role, and assigning or removing
  one, needs every permission that role carries. Only an administrator can assign
  `administrator`.
- Buyer roles hold buyer permissions, each with an access level. A buyer with several roles gets
  the widest level per permission.
- Permissions are read from the database on every request, so a change takes effect at once,
  without waiting for sessions to end.
- Queries are scoped with `buyerScope`, which turns a buyer's access level into a Drizzle `SQL`
  predicate over the record's owner and customer columns. The caller supplies a context: buyer
  user id, customer id, and the customer's descendants as a list of ids or a subquery. The
  customers module will own the hierarchy and export a function that returns that subquery
  (for example a recursive CTE over its own table), so access never reads customer tables.
- Role assignments refer to identity users by id without a foreign key, because a module never
  touches another module's tables. Access checks the user's realm through identity's public
  `findUserById` before assigning, so an admin role can never reach a buyer, or the reverse.

## Consequences

- Identity stays about authentication; authorization can change without touching sign-in.
- Every admin request that checks a permission costs one indexed query.
- Assignments for a user who is later deleted are left behind. Users are disabled rather than
  deleted today; if deletion arrives, identity must publish an event that access handles.
- Buyer roles are global for now. Customer-specific buyer roles, if needed, add a nullable
  `customer_id` column later.
- The customers module must provide the descendant subquery before any buyer query can use
  "my customer and subsidiaries".
