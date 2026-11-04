# 0028: Admin users screen and admin invitations

- Status: proposed
- Date: 2026-11-04

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

### Not built

- **Password reset** ("forgot password") for admins or buyers. The invitation token is shaped
  so a reset can reuse it later, but a reset is its own decision.
- **Editing an admin's name or email.**
- **Deleting admin users.** Disabling keeps the history of who did what.

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
