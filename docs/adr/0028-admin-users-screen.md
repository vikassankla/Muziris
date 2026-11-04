# 0028: Admin users screen and admin invitations

- Status: accepted
- Date: 2026-11-04
- Amended: 2026-11-04 (acting on an admin user who holds more permissions; see below)

## Context

Admins exist only through `admin:create` on the server. Access control (ADR 0006) already
has admin roles, the permissions `admin_user.view` ("See admin users") and `admin_user.manage`
("Create, edit and disable admin users"), and routes to assign and remove admin roles. It
never removes the last administrator. Two-factor sign-in (ADR 0026) added
`POST /admin/v1/access/admin-users/:userId/two-factor/reset` and `admin:reset-2fa`; the reset
has no screen.

What is missing:

- **No list.** No route lists admin users, their roles, whether they have two-factor sign-in,
  their status or their last sign-in.
- **No way to add an admin** from the admin app. `admin:create` asks for the password on the
  server, so a second admin has to share a shell.
- **No way to disable or re-enable an admin**, short of the database. Identity has
  `disableUser`, which also ends the user's sessions, but no route uses it for admins and there
  is no `enableUser`.

Buyers join by invitation (ADR 0020): an email with a one-time link, accepted in the
storefront, where they set a password. There is no password reset for anyone yet.

The admin design boards have no admin users board; AdminRoles is the nearest.

## Decision

### Screen

- **`/admin-users`**, in the sidebar under System for `admin_user.view`.
  - A paged table: **Name**, **Email**, **Admin roles**, **Two-factor** (On, or Not set up),
    **Status** (Active, Invited, Disabled) and **Last sign-in**.
  - **Invite an admin user**, for `admin_user.manage`: name, email and the admin roles to give.
    The roles listed are the ones the inviting admin may assign (`admin_role.assign`).
  - Row actions, for `admin_user.manage`:
    - **Reset two-factor**, with a confirmation that says the admin must set it up again at
      their next sign-in and is signed out everywhere now. Not offered on your own row: use
      the Security page.
    - **Disable** and **Enable**, with a confirmation. Disabling ends the admin's sessions.
      You cannot disable yourself, and the last active administrator cannot be disabled.
    - **Send invitation again**, while the admin has not accepted.
  - Roles are assigned and removed on the same row for `admin_role.assign`, through the
    existing routes, with their existing refusals.

### Admin invitations

- Inviting creates the admin account with **no password** and status active, and queues an
  **admin invitation email** through the outbox (ADR 0020) with a link to the admin app:
  `/accept-invitation#token=…`. The token is random, stored as a hash, used once and good for
  72 hours, as buyer invitations are. It is never in a response, a log or a URL query.
- The link opens **`/accept-invitation`** in the admin app: the admin sets a password (the same
  policy as everywhere), then goes to sign-in, where two-factor enrolment is required at once
  (ADR 0026). Accepting does not sign them in: the password and the second factor are both
  needed, every time.
- Until accepted, the account cannot sign in (it has no password). Sending again replaces the
  token, so the old link stops working.
- The token table lives in identity (`identity_invitation`, admin realm only for now), not in
  customers, because an admin is not a buyer user of any customer. Buyer invitations stay in
  customers.

### API additions

Under `/admin/v1/access`:

- **`GET /admin-users`** (`admin_user.view`): paged, each with name, email, roles, two-factor
  on or not, status, invited (not yet accepted) and last sign-in.
- **`POST /admin-users`** (`admin_user.manage`): name, email and role ids. Roles outside what
  the caller may assign are refused, and so is an email already in use.
- **`POST /admin-users/:userId/invitation`** (`admin_user.manage`): sends the invitation again.
- **`POST /admin-users/:userId/disable`** and **`/enable`** (`admin_user.manage`), refusing
  yourself and the last active administrator.

Under `/admin/v1/auth`, without a session:

- **`POST /accept-invitation`**: the token and the new password. The same per-IP rate limit as
  sign-in. A wrong, used or expired token answers one generic refusal.

Every change logs who did it to whom, never the token or the password.

### As built

Where the build differs from the plan above, or settles something it left open:

- **Invited** means the account has no password yet; the list works it out from that, not from
  the invitation. Inviting creates the account and the invitation in one transaction with the
  email; the roles are given right after, by `assignAdminRole`, once
  `assertAdminRolesAssignable` has checked them all.
- **Giving roles when inviting** needs `admin_role.assign` as well as `admin_user.manage`. The
  invite sheet offers only the roles whose permissions the inviter holds.
- **`POST /admin/v1/auth/invitation`** was added beside the accept route, as for buyers: it
  answers who the invitation is for, so the page can greet them. Both share the buyer
  invitation's rate limits, and every refusal is 404 `invitation_invalid`.
- **Accepting** answers `{email}` and sets no cookie. A disabled account's link stops working.
- **The link** is `<ADMIN_PUBLIC_URL>/accept-invitation#token=…`. `ADMIN_PUBLIC_URL` is a new
  mail setting beside `STOREFRONT_PUBLIC_URL`, required in production.
- **The last administrator** check on disable counts active holders of a role that grants every
  permission, as removing the role does. It does not lock, so two disables at the same moment
  could both pass; `admin:create` recovers.
- **Reset two-factor** is offered only for an admin who has it set up. **Enable** leaves the
  admin's ended sessions ended.
- **Refusals** answer `own_account` (disabling yourself), `last_administrator`, `email_taken`,
  `not_invited` (sending again after accepting), `privilege_escalation`, `outranked` (since the
  amendment below) and `user_not_found`.
- **Roles on the row** change in a dialog, one at a time, through the existing routes. The
  Admin roles page's "Admin users" card now points there.

### Not built

- **Password reset** ("forgot password") for admins or buyers. The invitation token is shaped
  so a reset can reuse it later, but a reset is its own decision.
- **Editing an admin's name or email.**
- **Deleting admin users.** Disabling keeps the history of who did what.

### Amendment, 2026-11-04: acting on an admin user who holds more permissions

The security pass (`docs/security-review.md`, finding 5) found that `admin_user.manage` let an
admin user disable, enable or reset the two-factor sign-in of any other admin user, including
administrators. Nobody could take an account over that way, but an admin user with a narrow
role could lock every administrator out. Vikas decided in chat on 2026-11-04:

- **Disabling, enabling and resetting two-factor sign-in** need every permission the other admin
  user holds, as giving a role already does. Only an admin user with every permission may act
  on an administrator. Anything else is refused with `outranked` (403).
- **Sending an invitation again** is unchanged: it only emails the invited address.
- **The list** says, for each admin user, whether the signed-in admin may act on them
  (`mayManage`), and the screen offers those three actions only where it is true. A row with
  nothing to offer has no menu.
- **The last administrator** check stays, though through the API it is now reached only by an
  administrator acting on themselves, which `own_account` refuses first: it guards the module's
  own callers and the race above.

## Consequences

- A second admin can be added, and a lost phone recovered, without a shell on the server.
  `admin:create` stays for the first admin and for emergencies.
- This is authentication and access control, so the pull request needs a second human review
  under CLAUDE.md rule 4.
- Identity gains its own invitation table, `enableUser`, and a list of admin users; access
  gains a lookup of roles per admin user. One migration in identity.
- The admin app gains a page outside the session, `/accept-invitation`, with the same security
  headers as sign-in.
- A journey checks it end to end: invite an admin, accept from the email in Mailpit, sign in
  with two-factor enrolment, then disable them and see their session end.
