# 0020: Transactional emails through an outbox

- Status: proposed
- Date: 2026-11-01

## Context

Week 4 includes emails, which are also first in line to cut if a week slips. Two things wait
for them:

- Buyer invitations. The admin API returns the invitation token today because no email carries
  it (ADR 0010). The storefront also has no page to accept an invitation.
- Order emails: the buyer is told the order was placed and how it moves, and the seller is told
  a new order arrived.

The spec asks that workflow transitions emit events that emails can subscribe to (FR-WF-3), and
calls for a notification catalogue listing each email's trigger, recipients and template.

What exists:

- Mailpit runs in Docker Compose, and `.env.example` sets `SMTP_URL`.
- There is no job runner yet: pg-boss is an open item.

An email must never be sent for a change that rolled back, and it must never be lost because
the mail server was down for a minute.

## Decision

### An outbox, in a new module `modules/notifications`

**The outbox table.** `notification_outbox` holds:

- the kind (for example `buyer_invitation` or `order_placed`), the recipient, the locale, and
  the subject, text and HTML;
- the status (`queued`, `sent`, `failed`), the attempts, the next attempt time, the last error
  code, and the created and sent times.

**Queueing.** A module queues an email by inserting an outbox row in the same transaction as the
change itself, for example the invitation or the order transition. If the change rolls back, so
does the email. Each kind has an idempotency key, such as `order_placed:<order id>`, so the
same email is never queued twice.

**Sending:**

- A sender claims due rows with `FOR UPDATE SKIP LOCKED` and sends them over SMTP. Several API
  processes can run it safely.
- A failure is retried with backoff (1, 5, 30 and 120 minutes). After five attempts the row
  becomes `failed` and an error is logged. Admins can list failed emails and send one again.
- The sender runs as a loop inside the API process, every 10 seconds, and is also available as
  `pnpm --filter @muziris/api notifications:send` for scripts. When the job runner arrives,
  the loop moves into it unchanged.

**Tokens don't stay in the database.** An email that carries a token (the invitation) has its
body emptied once it is sent; the subject and recipient remain for the log. While it waits, the
token sits in the outbox row and in the invitation, which stores only the token's hash.

### Delivery and configuration

- **Settings:**
  - `SMTP_URL`: Mailpit locally, any SMTP relay in production. It can hold a password, so it is
    treated as a secret: environment only, never logged.
  - `MAIL_FROM`: the From address.
  - `STOREFRONT_PUBLIC_URL`: the base for links in emails.
- **One new dependency, `nodemailer`.** SMTP with TLS, authentication and correct MIME encoding
  is too much to write and review ourselves. `nodemailer` is the standard library for it and has
  no dependencies of its own.
- **Templates** are TypeScript functions per kind and locale (en-IN, en-US). Each returns a
  subject, a text body and a simple HTML body with every value escaped, and formats money and
  dates with `@muziris/money` and the website's time zone. Snapshot tests cover each template.

### The pilot's catalogue

| Kind               | Trigger                           | To                                      |
| ------------------ | --------------------------------- | --------------------------------------- |
| `buyer_invitation` | an admin invites a buyer user     | the invited email                       |
| `order_placed`     | `placeOrder` succeeds             | the buyer who placed it                 |
| `order_received`   | `placeOrder` succeeds             | the `notifications.order_email` setting |
| `order_confirmed`  | the `confirm` transition          | the buyer who placed it                 |
| `order_declined`   | the `decline` transition          | the buyer who placed it                 |
| `order_completed`  | the `complete` transition         | the buyer who placed it                 |
| `payment_received` | a payment becomes paid (ADR 0019) | the buyer who placed it                 |
| `payment_failed`   | a payment fails or is cancelled   | the buyer who placed it                 |

- `notifications.order_email` is a website-level setting, off when empty.
- The catalogue lives in `docs/notifications.md`, as the spec asks.
- These are transactional emails, so there is no unsubscribe. Marketing email is out of scope.

### Accepting an invitation

- **The admin API.** It stops returning the invitation token and queues the invitation email
  instead. This changes the admin API: the admin app's "copy invitation link" becomes
  "invitation sent", plus "send again", which queues a new email with a new token and revokes the
  old one.
- **The storefront page** `/accept-invitation?token=…` shows the invited name and email and asks
  for a password. It calls `POST /storefront/v1/auth/accept-invitation`, which uses
  `acceptInvitation` (customers) and identity's account creation, signs the buyer in, and sends
  them to the catalogue.
- **Access to the endpoint** is limited per IP address and token, like sign-in. The token is
  never put in a log or sent to another service.

## Consequences

- Invitations work end to end without an admin copying links, and buyers hear about their
  orders.
- An email is queued if and only if its change commits, and it survives a mail server outage.
- One new dependency (`nodemailer`), with the reason given above.
- The admin API's invitation response changes. The admin app and its tests change with it.
- This touches authentication (accepting an invitation creates an account and a session) and
  secrets, so its pull requests need a second human reviewer under CLAUDE.md rule 4.
- Not in the pilot: WhatsApp and SMS, templates edited in the admin, a sender address per
  website, bounce handling, and email for quotes and RFQs.
