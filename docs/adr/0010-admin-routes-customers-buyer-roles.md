# 0010: Admin routes for customers and buyer roles, with paged lists

- Status: proposed
- Date: 2026-10-28

## Context

The admin app shell (week 2, item 5) needs HTTP routes over the customers module (ADR 0008) and
over buyer roles in the access module (ADR 0006). Both modules had admin functions but no
routes. Their list functions returned every row, which is unbounded for customers, buyer users
and invitations. The catalog already pages products by SKU (ADR 0009). Invitation emails are
not built until week 4, and the storefront route that accepts an invitation does not exist yet.

## Decision

Customers get admin routes under `/admin/v1/customers`; buyer roles join the admin roles under
`/admin/v1/access`. Every admin list endpoint is paged, and an invitation's token is returned
once, in the response that creates it, until invitation emails exist.

- **Permissions.** Customer routes need `customer.view` to read and `customer.manage` to
  change. Buyer role routes, including assigning and unassigning a buyer role, need
  `buyer_role.view` and `buyer_role.manage`. The catalogue needed no new permission.
- **Paging.** Admin list functions take `{ after?, limit }` and return the rows with
  `nextAfter`. `limit` defaults to 50 and may not exceed 200. Each list has a total order that
  ends in the row's id (customers by name, customer groups and buyer roles by code, buyer users
  and invitations by creation time, addresses defaults first then by label), and `after` is
  the id of the previous page's last row. The next page starts after that row's key with one
  row comparison against a subquery, so a page costs one index range scan however deep it is.
  An `after` that matches no row gives an empty page. The catalog keeps its SKU cursor.
- **Changed signatures.** `listCustomerGroups`, `listBuyerUsers`, `listPendingInvitations`,
  `listAddresses` and `listBuyerRoles` now return a page instead of an array. `listCustomers`
  is new and also serves subsidiaries (`parentId`), top-level customers and customers in a
  customer group. `listSubsidiaries` is unchanged.
- **Invitation tokens.** `POST /admin/v1/customers/{customerId}/invitations` returns the token
  so the admin can pass on the link by hand. It is never logged and the response is
  `no-store`. An admin who can do this can already create a buyer user with a password, so
  the token gives them nothing new. When invitation emails ship, the token goes into the email
  and leaves the response.
- **Buyer users created by an admin** may be given a password, which must meet identity's
  password policy, or none, for an account that sets its password later.
- **Addresses.** The customer always comes from the path; a `customerId` in the body is
  overwritten.

## Consequences

- The admin app can page every list the same way, and no admin request reads an unbounded
  number of rows.
- A page's order is stable only while its key columns do not change; renaming a customer
  between two page requests can make it appear twice or not at all. That is acceptable for an
  admin list.
- The buyer users list carries identity user ids, not names or emails. Showing names needs a
  batch lookup in identity's public interface, which does not exist yet.
- Removing the invitation token from the response is a breaking change for the admin app,
  planned with the email work in week 4.
- The default buyer role for invited buyer users is still open (ADR 0006, ADR 0008); these
  routes do not assign one.
