# Notifications

The emails Muziris sends, and how they are sent (ADR 0020). Code: `modules/notifications`, and
the wiring in `apps/api/src/emails.ts`.

## The catalogue

| Kind               | Trigger                                   | To                                      | Holds a secret |
| ------------------ | ----------------------------------------- | --------------------------------------- | -------------- |
| `buyer_invitation` | an admin invites a buyer user, or resends | the invited email                       | yes, the link  |
| `order_placed`     | `placeOrder` succeeds                     | the buyer who placed it                 | no             |
| `order_received`   | `placeOrder` succeeds                     | the `notifications.order_email` setting | no             |
| `order_confirmed`  | the `confirm` transition                  | the buyer who placed it                 | no             |
| `order_declined`   | the `decline` transition, with its note   | the buyer who placed it                 | no             |
| `order_completed`  | the `complete` transition                 | the buyer who placed it                 | no             |
| `payment_received` | a payment becomes paid (ADR 0019)         | the buyer who placed it                 | no             |
| `payment_failed`   | a payment fails or is cancelled           | the buyer who placed it                 | no             |

- **Templates** are in `modules/notifications/src/templates.ts`: one function per kind, each
  returning a subject, a text body and an HTML body with every value escaped. Money and dates
  use the website's locale and time zone. Snapshot tests cover each kind.
- **`notifications.order_email`** is a website-level setting. Empty, the default, sends no
  `order_received` email.
- **Invitations** come from the website named by `STOREFRONT_WEBSITE` (default `main`), for its
  name and time zone. If that website is missing, a warning is logged and the email still goes,
  as "Muziris" in Asia/Kolkata.
- These are transactional emails, so there is no unsubscribe link.

## Idempotency keys

Each email has a key, unique in the outbox, so retrying a change never queues it twice:

- `buyer_invitation:<invitation id>`. Resending makes a new invitation, so a new key.
- `order_placed:<order id>`, `order_received:<order id>`, and `<kind>:<order id>` for the
  transitions.
- `payment_received:<payment id>`.
- `payment_failed:<payment id>:<time>`. A payment can fail more than once before it succeeds,
  and each failure is told once.

## How an email is queued and sent

1. **Queued with its change.** The email is rendered and inserted into `notification_outbox` in
   the same transaction as the change it reports: the invitation, the placed order, the
   transition, the payment status. If the change rolls back, so does the email. Everything the
   email needs (the buyer, the website, the setting) is read before that transaction starts, so
   the hook holds no second connection.
2. **Sent by the sender.** It claims one due row at a time with `FOR UPDATE SKIP LOCKED`, so
   several API processes can run it without sending an email twice.
   - In the API process: every 10 seconds, when `SMTP_URL` is set. It moves into the job runner
     when pg-boss arrives.
   - From a script: `pnpm --filter @muziris/api notifications:send` sends what is due, once.
3. **Retried with backoff.** A failed send waits 1, 5, 30 and then 120 minutes. The fifth failure
   marks the email `failed` and logs it. Only the error code is kept (`smtp_550`, or nodemailer's
   code such as `ECONNREFUSED`), never the server's text, which can quote addresses.
4. **Secrets are emptied.** An email that holds a secret has its text and HTML bodies emptied
   once it is sent or has failed. The subject and recipient stay for the log.

## The invitation link

The link is `<STOREFRONT_PUBLIC_URL>/accept-invitation#token=<token>`. The token is in the
fragment, which the browser never sends to a server, so it cannot reach an access log or a
`Referer` header. The storefront page reads it, removes it from the address bar, and calls:

- `POST /storefront/v1/auth/invitation` with `{token}`: the invited email, name, customer and
  expiry.
- `POST /storefront/v1/auth/accept-invitation` with `{token, password, displayName?}`: creates
  the buyer user, signs them in, and answers 201.

Both are limited per IP address (30 per 10 minutes) and per token (10 per 10 minutes). An
unknown token is a 404, an expired one a 410, and an accepted or revoked one, or an email already in use, a 409.

## The admin Emails page

System > Emails (`/emails`) lists the outbox, newest first, with a status filter. It needs
`notification.view`. It shows the subject, the recipient, the status and the last error code,
never the body.

"Send again" on a failed email needs `notification.manage` and queues it from its first
attempt. A failed email that held a secret was emptied and cannot be sent again: use "Send
again" on the invitation instead, which revokes the old token and sends a new one.

The API behind it: `GET /admin/v1/notifications?status=&after=&limit=` and
`POST /admin/v1/notifications/:emailId/retry`.

## Configuration

From the environment only; see `.env.example`.

| Variable                | Meaning                                                   | Unset             |
| ----------------------- | --------------------------------------------------------- | ----------------- |
| `SMTP_URL`              | `smtp://` or `smtps://`; a secret, redacted from logs     | emails queue only |
| `MAIL_FROM`             | the From address                                          | a localhost value |
| `STOREFRONT_PUBLIC_URL` | the storefront's address, for links (https in production) | localhost:5174    |
| `STOREFRONT_WEBSITE`    | the code of the website invitations come from             | `main`            |

In production, `SMTP_URL`, `MAIL_FROM` and `STOREFRONT_PUBLIC_URL` are required and the API
does not start without them. Locally, Mailpit from `docker-compose.yml` receives everything; its
inbox is at http://localhost:8025.

## Not in the pilot

WhatsApp and SMS, templates edited in the admin, a sender address per website, bounce handling,
and emails for quotes and RFQs.
