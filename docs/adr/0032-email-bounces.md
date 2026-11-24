# 0032: Email bounces and spam complaints, through Postmark

- Status: accepted (Vikas, in chat, 2026-11-24)
- Date: 2026-11-24

## Context

ADR 0020 sends every email through an outbox over SMTP and left bounce handling out of the
pilot. Vikas asked for it on 2026-11-10. On 2026-11-24 he chose Postmark as the mail provider,
so it is the relay `SMTP_URL` points at in production.

Today an email counts as sent once the relay accepts it. When the recipient's server later
refuses it (no such mailbox, a full mailbox, a blocked domain), nobody hears:

- the admin sees "sent" on System > Emails;
- the buyer never gets the invitation, and an admin keeps sending it again;
- an order email to a dead `notifications.order_email` address is lost without a trace;
- every further email to that address bounces too. Repeated hard bounces and spam complaints
  harm the sender's reputation, and Postmark can suspend sending for a high bounce rate.

What Postmark gives:

- SMTP sending, with the server token as user name and password, and the
  `X-PM-Message-Stream` header to choose a message stream (`outbound` for transactional mail).
- Webhooks, sent as an HTTPS POST of JSON: a **bounce** webhook (`RecordType: "Bounce"`, with a
  `Type` such as `HardBounce`, `SoftBounce`, `Transient`, `SpamNotification`, the recipient
  `Email`, a numeric `ID`, `BouncedAt` and `Inactive`) and a **spam complaint** webhook
  (`RecordType: "SpamComplaint"`).
- Metadata: `X-PM-Metadata-<name>` headers on an SMTP message come back in its webhooks.
- Postmark deactivates an address after a hard bounce or a spam complaint and stops delivering
  to it until it is reactivated in Postmark.
- Webhooks are not signed. Postmark's advice is to put basic authentication credentials in the
  webhook URL, and optionally to allow only its published IP ranges.

The field names, types and the SMTP header behaviour above are as Postmark documents them;
the build checks each one against Postmark's documentation and a sandbox server before relying
on it.

## Decision

### A suppression list, kept by Muziris

A new table `notification_suppression` in the notifications module: one row per email address
(stored lowercased, unique), with:

- the reason: `hard_bounce`, `spam_complaint`, `smtp_rejected` or `manual`;
- the source: `postmark`, `smtp` or `admin`;
- Postmark's bounce type and type code, when it came from Postmark (never its free-text
  description, which can quote addresses and server replies);
- the first and the last time it was seen, and the outbox email that caused it, if any.

The list is Muziris's own, so it also works without Postmark (locally with Mailpit, or if the
provider changes), and the admin can see it without Postmark's dashboard.

**Sending checks it.** Before sending, the sender looks the recipient up. A suppressed address
is not sent to: the outbox row becomes `suppressed`, not `sent`, with no attempt made. This
covers every kind of email, the invitation included.

### Two ways an address gets on the list

1. **Refused at send time.** When the relay refuses the recipient itself with a permanent
   reply (a 5xx reply to `RCPT TO`, which nodemailer reports per recipient), the row becomes
   `failed` at once, without the four retries, and the address is suppressed as
   `smtp_rejected`. Any other failure, including a 5xx about authentication or the message
   (535, 552, 554 to `DATA`), is retried as today and suppresses nothing: it is about our setup,
   not the address.
2. **Reported later by Postmark.** `POST /webhooks/postmark` takes both webhooks:
   - a bounce of type `HardBounce`, `BadEmailAddress`, `ManuallyDeactivated` or
     `SpamNotification`, or any bounce with `Inactive: true`, suppresses the address as
     `hard_bounce`;
   - a spam complaint suppresses it as `spam_complaint`;
   - any other bounce (`SoftBounce`, `Transient`, `DnsError`, auto-replies and the like) is
     recorded on the outbox email only. Postmark keeps retrying those itself.

   Each webhook marks the outbox email it is about as `bounced`, with the bounce type. The
   email is found through an `X-PM-Metadata-outbox-id` header the sender adds to every message
   (the outbox row's id, which is not personal data). A webhook for an email we cannot find
   still suppresses the address.

   A webhook is recorded once: Postmark's bounce `ID` is kept, and a repeat is acknowledged and
   ignored.

### The webhook endpoint

- On the storefront domain, beside the payment webhooks: `/webhooks/postmark`, which Caddy
  already sends to the API (ADR 0029).
- **Authentication:** HTTP basic authentication. `POSTMARK_WEBHOOK_USER` and
  `POSTMARK_WEBHOOK_PASSWORD` come from the environment (ADR 0019's rule: secrets only from the
  environment, never logged). They are compared in constant time. The password must be at least
  24 random characters, or the API does not start. Without both variables the endpoint answers
  404, as if it did not exist.
- It takes only JSON up to 64 KB, is rate limited per IP like the payment webhooks, and answers
  200 for anything it read, including a record it ignored. A body it cannot read is a 400.
  Postmark retries on other answers.
- It logs the record type, bounce type, bounce id and outbox email id, never the address or
  the description.
- Allowing only Postmark's IP ranges is left to the operator's firewall or Caddy, and
  `docs/install.md` says how. The ranges change, so they are not built in.

### What the admin sees

- **System > Emails** gains two statuses, **Bounced** (with the bounce type, such as "Hard
  bounce" or "Spam complaint") and **Not sent: address suppressed**, and a status filter for
  each.
- **System > Emails > Suppressed addresses**, a new tab: the address, the reason, the source
  and the dates, newest first, searchable by address. It needs `notification.view`.
- **Remove from the list** needs `notification.manage` and asks for confirmation. It removes the
  address from Muziris's list only. Postmark keeps its own deactivation, so the confirmation says
  to reactivate the address in Postmark too, or emails will bounce again. Calling Postmark's API
  to do that is left for later (see Not chosen).
- **Add an address** (`notification.manage`, reason `manual`), for an address a customer asked
  not to be mailed.
- **The Settings page** warns under `notifications.order_email` when that address is
  suppressed: "New order emails to this address are not sent: it bounced on <date>." This uses
  the setting warnings added in PR 62.

A change to the list is logged with the admin's user id and the reason, never the address.

### Configuration

| Variable                    | Meaning                                                         | Unset                       |
| --------------------------- | --------------------------------------------------------------- | --------------------------- |
| `SMTP_URL`                  | For Postmark: `smtp://<token>:<token>@smtp.postmarkapp.com:587` | as today                    |
| `POSTMARK_MESSAGE_STREAM`   | The stream for every email; default `outbound`                  | `outbound`                  |
| `POSTMARK_WEBHOOK_USER`     | Basic auth user name in the webhook URL                         | the webhook endpoint is off |
| `POSTMARK_WEBHOOK_PASSWORD` | Basic auth password, at least 24 random characters; secret      | the webhook endpoint is off |

Setting one of the two webhook variables without the other stops the API at startup, as partly
set gateway keys do. The `X-PM-*` headers are added only when `SMTP_URL`'s host is
`smtp.postmarkapp.com`, so other relays get a clean message.

`docs/install.md` gains a Postmark section: create a server and its transactional stream,
verify the sending domain (DKIM and Return-Path DNS records), put the server token in
`SMTP_URL`, and add the webhook `https://<user>:<password>@<STOREFRONT_DOMAIN>/webhooks/postmark`
for bounces and spam complaints.

### Schema

One migration:

- the `notification_suppression` table;
- `notification_outbox` gains `bounce_type` (null unless bounced), and its status check allows
  `bounced` and `suppressed`. `sent_at` stays set on a bounced email, since it was sent;
- `notification_bounce_event`: Postmark's bounce `ID` (unique), the record type, the bounce type
  and code, the outbox email id and the received time, so a repeated webhook is ignored. Like
  `payment_transaction`, rows are never changed.

### Glossary

Adds **Suppressed address**: an email address Muziris does not send to, because it bounced
permanently, its owner marked an email as spam, or an admin added it. Not to be confused with a
failed email, which is one message that could not be sent.

## Consequences

- An address that bounces permanently stops getting emails after the first bounce, which
  protects the sender's reputation and Postmark's limits.
- Admins see which emails bounced and why, and can find out why an invitation never arrived.
- An admin who removes an address must also reactivate it in Postmark. The screen says so.
- The suppression list holds email addresses, which are personal data. They stay after a buyer
  user or customer is deleted, because the list's job is to stop mail to that address. An admin
  can remove one. `docs/security-review.md` records this.
- A new webhook secret, an endpoint that changes outbox state from outside, and the
  invitation flow (authentication), so the pull request needs a second human review under
  CLAUDE.md rule 4.
- No new dependency: the webhook is plain JSON over the existing webhook routes, and nodemailer
  already reports refused recipients.
- Nothing changes for development: Mailpit never bounces, and the webhook stays off.

### Not chosen

- **Amazon SES, Brevo, SendGrid, Mailgun:** Vikas chose Postmark on 2026-11-24. The suppression
  list does not depend on the provider, so another one would need only its own webhook adapter.
- **Only send-time SMTP refusals:** misses the bounces that come back later, which are most of
  them.
- **Reading bounce emails from a mailbox over IMAP:** works with any relay, but needs a new
  dependency, a mailbox and the parsing of many bounce formats.
- **Calling Postmark's API** to reactivate an address or to copy its suppression list: needs the
  server token in the API for more than SMTP, and an admin action that calls Postmark. Useful
  later; for the pilot, reactivating in Postmark's dashboard is enough.
- **Delivery and open tracking webhooks:** not needed to stop bounces, and open tracking adds a
  tracking pixel to transactional mail.
