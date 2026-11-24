# Notifications

The emails Muziris sends, and how they are sent (ADR 0020). Code: `modules/notifications`, and
the wiring in `apps/api/src/emails.ts`.

## The catalogue

| Kind               | Trigger                                               | To                                      | Holds a secret |
| ------------------ | ----------------------------------------------------- | --------------------------------------- | -------------- |
| `buyer_invitation` | an admin invites a buyer user, or resends             | the invited email                       | yes, the link  |
| `admin_invitation` | an admin invites an admin user, or resends (ADR 0028) | the invited email                       | yes, the link  |
| `order_placed`     | `placeOrder` succeeds                                 | the buyer who placed it                 | no             |
| `order_received`   | `placeOrder` succeeds                                 | the `notifications.order_email` setting | no             |
| `order_confirmed`  | the `confirm` transition                              | the buyer who placed it                 | no             |
| `order_declined`   | the `decline` transition, with its note               | the buyer who placed it                 | no             |
| `order_completed`  | the `complete` transition                             | the buyer who placed it                 | no             |
| `payment_received` | a payment becomes paid (ADR 0019)                     | the buyer who placed it                 | no             |
| `payment_failed`   | a payment fails or is cancelled                       | the buyer who placed it                 | no             |

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
- `admin_invitation:<invitation id>`, likewise.
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
   several API processes can run it without sending an email twice. An email to a suppressed
   address is not sent: it becomes `suppressed` (see Bounces below).
   - As the `notifications.send` job (ADR 0025), when `SMTP_URL` is set: queued in the email's
     own transaction, so it starts once the change commits, and every minute as well. It runs
     wherever the job workers run, the API process by default.
   - From a script: `pnpm --filter @muziris/api notifications:send` sends what is due, once.
3. **Retried with backoff.** A failed send waits 1, 5, 30 and then 120 minutes. The fifth failure
   marks the email `failed` and logs it. Only the error code is kept (`smtp_550`, or nodemailer's
   code such as `ECONNREFUSED`), never the server's text, which can quote addresses. When the
   relay refuses the recipient itself with a 5xx reply to `RCPT TO`, the email fails at once,
   without retries, and the address is suppressed.
4. **Secrets are emptied.** An email that holds a secret has its text and HTML bodies emptied
   once it is sent or has failed. The subject and recipient stay for the log.

## Bounces and suppressed addresses

ADR 0032. Postmark is the relay in production. Muziris keeps its own list of suppressed
addresses in `notification_suppression`, and the sender checks it before every email.

| Status       | Meaning                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| `queued`     | waiting to be sent, or to be tried again                                              |
| `sent`       | the relay took it                                                                     |
| `failed`     | five attempts failed, or the relay refused the recipient                              |
| `bounced`    | sent, then Postmark reported a bounce or spam complaint; `bounce_type` says which     |
| `suppressed` | not sent: the address is suppressed. A secret in its body is emptied as for any other |

An address is suppressed when:

- the relay refuses it with a 5xx reply to `RCPT TO` (reason `smtp_rejected`);
- Postmark reports a bounce of type `HardBounce`, `BadEmailAddress`, `ManuallyDeactivated` or
  `SpamNotification`, or any bounce that deactivated the address (`Inactive`), as `hard_bounce`;
- Postmark reports a spam complaint, as `spam_complaint`;
- an admin adds it, as `manual`.

Soft bounces (`SoftBounce`, `Transient`, `DnsError`, auto-replies) only mark the email
`bounced`: Postmark retries those itself. Postmark's description and details are never kept or
logged; they can quote addresses and server replies.

Through Postmark, each email carries `X-PM-Message-Stream` and `X-PM-Metadata-outbox-id` (its
outbox row's id), and the webhook finds the email by that id. Both headers are added only when
the relay is `smtp.postmarkapp.com`. A bounce for an email Muziris cannot find still suppresses
the address.

`POST /webhooks/postmark` takes Postmark's bounce and spam complaint webhooks:

- basic authentication from `POSTMARK_WEBHOOK_USER` and `POSTMARK_WEBHOOK_PASSWORD`, compared
  in constant time; a wrong or missing one is a 401. Without both variables the endpoint is a
  404;
- JSON up to 64 KB, rate limited per IP like the payment webhooks;
- each event once, by Postmark's `ID`, in `notification_bounce_event`; a repeat is a 200;
- 200 for anything it read, including records it does not handle (deliveries, opens); 400 for a
  body it cannot read. Postmark does not retry a 4xx answer.

It logs the record type, bounce type, bounce id and email id, never the address.

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

## The admin invitation link

The link is `<ADMIN_PUBLIC_URL>/accept-invitation#token=<token>`, in the fragment for the same
reason. The admin app's page calls `POST /admin/v1/auth/invitation` with `{token}` (the
invited email, name and expiry) and `POST /admin/v1/auth/accept-invitation` with
`{token, password}`, which sets the password and answers 200 without signing in: the admin
then signs in and enrols a second factor (ADR 0026). The link works once and for 72 hours.
Every refusal (unknown, used, expired, a disabled account) is the same 404,
`invitation_invalid`. The rate limits are the buyer invitation's.

## The admin Emails page

System > Emails (`/emails`) lists the outbox, newest first, with a status filter. It needs
`notification.view`. It shows the subject, the recipient, the status and the last error code,
never the body.

"Send again" on a failed email needs `notification.manage` and queues it from its first
attempt. A failed email that held a secret was emptied and cannot be sent again: use "Send
again" on the invitation instead, which revokes the old token and sends a new one.

Bounced emails show their bounce type, such as "Hard bounce", and emails to a suppressed
address show "Not sent: address suppressed".

The **Suppressed addresses** tab lists the list, newest first, searchable by address, under
`notification.view`. With `notification.manage` an admin can add an address (for one whose
owner asked not to be mailed) and remove one. Removing only clears Muziris's list: Postmark
keeps its own block, so the admin must also reactivate the address in Postmark, or emails to it
bounce again. The screen says so. A change is logged with the admin and the reason, never the
address.

The Settings page warns under `notifications.order_email` when that address is suppressed,
since new order emails to it are not sent.

The API behind it: `GET /admin/v1/notifications?status=&after=&limit=`,
`POST /admin/v1/notifications/:emailId/retry`, `GET /admin/v1/notifications/suppressions?search=&after=&limit=`,
`POST /admin/v1/notifications/suppressions` with `{email}`, and
`DELETE /admin/v1/notifications/suppressions/:suppressionId`.

## Configuration

From the environment only; see `.env.example`.

| Variable                    | Meaning                                                   | Unset             |
| --------------------------- | --------------------------------------------------------- | ----------------- |
| `SMTP_URL`                  | `smtp://` or `smtps://`; a secret, redacted from logs     | emails queue only |
| `MAIL_FROM`                 | the From address                                          | a localhost value |
| `STOREFRONT_PUBLIC_URL`     | the storefront's address, for links (https in production) | localhost:5174    |
| `ADMIN_PUBLIC_URL`          | the admin app's address, for admin invitation links       | localhost:5173    |
| `STOREFRONT_WEBSITE`        | the code of the website invitations come from             | `main`            |
| `POSTMARK_MESSAGE_STREAM`   | Postmark's stream for every email                         | `outbound`        |
| `POSTMARK_WEBHOOK_USER`     | the bounce webhook's basic auth user name                 | webhook is off    |
| `POSTMARK_WEBHOOK_PASSWORD` | its password, 24 or more random characters; a secret      | webhook is off    |

In production, `SMTP_URL`, `MAIL_FROM`, `STOREFRONT_PUBLIC_URL` and `ADMIN_PUBLIC_URL` are required and the API
does not start without them. Setting one of the two webhook variables without the other, or a
shorter password, also stops it. Locally, Mailpit from `docker-compose.yml` receives everything; its
inbox is at http://localhost:8025.

## Not in the pilot

WhatsApp and SMS, templates edited in the admin, a sender address per website, emails for quotes
and RFQs, reactivating an address in Postmark from the admin, and delivery and open tracking.
