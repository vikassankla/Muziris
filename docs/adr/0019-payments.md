# 0019: Card and bank payments through Stripe and Razorpay, in test mode

- Status: proposed
- Date: 2026-11-01

## Context

Orders are paid on terms today (ADR 0016: `payment_method = 'terms'`). The spec decides the
gateways: Stripe for the US (cards, ACH) and Razorpay for India (cards, UPI, net banking).
Payment methods are filtered by rules on destination, currency, subtotal and customer
(FR-CO-2), and the spec asks for a transaction log and payment statuses. Live payments wait
for the gateway accounts to be approved, so the pilot runs both gateways in test mode.

CLAUDE.md:

- Secrets come only from the environment and never appear in logs, errors, URLs or the
  repository.
- New dependencies need a reason.
- Payments need a second human reviewer (rule 4).

## Decision

### Credentials are configuration, from the environment only

Each gateway's keys are environment variables, read and checked with zod in
`apps/api/src/env.ts`, and listed (without values) in `.env.example`:

| Variable                  | What it is                                     | Secret |
| ------------------------- | ---------------------------------------------- | ------ |
| `STRIPE_SECRET_KEY`       | Server key, `sk_test_…`                        | Yes    |
| `STRIPE_PUBLISHABLE_KEY`  | Browser key, `pk_test_…`                       | No     |
| `STRIPE_WEBHOOK_SECRET`   | Signs Stripe's webhooks, `whsec_…`             | Yes    |
| `RAZORPAY_KEY_ID`         | Key id, `rzp_test_…`, also used in the browser | No     |
| `RAZORPAY_KEY_SECRET`     | Server key                                     | Yes    |
| `RAZORPAY_WEBHOOK_SECRET` | Signs Razorpay's webhooks                      | Yes    |

- **A gateway is on only when all of its variables are set.** With some of them missing, the API
  refuses to start and names the missing ones. With none set, the gateway is off and checkout
  offers terms only.
- **Live keys are refused** (`sk_live_`, `pk_live_`, `rzp_live_`) unless `PAYMENTS_LIVE=true`.
  The pilot never sets it. Going live is a later decision, made after account approval and the
  second review.
- **Secrets never go into the database or the admin settings, and never reach the browser.**
  Only the two browser keys (`pk_test_…` and the Razorpay key id), which the gateways publish by
  design, are sent, in the storefront's checkout data. The logger's redaction list gains the
  secret names, and error messages from a gateway are logged without request bodies or headers.
- **Which methods a website offers** is an ordinary, non-secret setting:
  `payment.methods`, a list from `terms`, `stripe_card`, `stripe_ach`, `razorpay`. It can be set
  at the global, organization, website, customer group or customer level, as with payment terms.
- **Matching gateways to currencies.** A method is shown only when its gateway is configured and
  supports the order's currency: Stripe for USD, Razorpay for INR.

### A payments module (`modules/payments`)

- **Tables:**
  - `payment`: one per order, holding the method, the gateway's reference (Stripe PaymentIntent
    or Razorpay order id), the amount and currency, and the status.
  - `payment_transaction`: the log. One row per gateway event, unique on (gateway, event id), so
    a webhook delivered twice is recorded once.
- **Statuses in the pilot:** `pending`, `paid`, `failed`, `cancelled`, `refunded`,
  `partially_refunded`. The spec's other states (authorised, captured separately, and so on)
  arrive if manual capture is ever needed.
- **The flow:**
  1. The buyer picks a card or bank method at checkout. `placeOrder` creates the order as now,
     with `payment_method` set to the method, a `pending` payment, and the due date of terms
     left empty.
  2. A new mutation, `startPayment(orderNumber)`, creates the PaymentIntent or the Razorpay
     order on the server, for the order's grand total in minor units. It returns what the
     browser needs: the client secret for Stripe, or the order id for Razorpay.
  3. The storefront shows the gateway's own payment form: Stripe's Payment Element from
     `js.stripe.com`, or Razorpay Checkout from `checkout.razorpay.com`. Card and bank details
     go straight to the gateway and never touch Muziris servers (PCI SAQ A).
  4. **Only a signed webhook marks a payment paid.** `POST /webhooks/stripe` checks the
     `Stripe-Signature` HMAC with the timestamp tolerance; `POST /webhooks/razorpay` checks
     `X-Razorpay-Signature` (HMAC-SHA256 of the raw body). An unsigned or stale request is a 400
     and changes nothing.
  5. The return page asks the API for the payment's status. When it is still pending, the API
     reads the payment from the gateway once, server to server, so a slow webhook does not
     leave the buyer waiting. What the browser reports is never trusted.
  6. A paid payment adds a log row and fires an event that the order workflow and emails can
     use (FR-WF-3). The seller still confirms the order through the workflow; an unpaid card
     order cannot be confirmed (a guard on `confirm`).
- **Amounts.** Each amount is checked against the order's grand total and currency, in minor
  units. A webhook whose amount or currency differs is logged and leaves the payment as it is.
- **Refunds** are made in the gateway's dashboard in the pilot. Their webhooks update the
  payment's status.
- **No gateway SDKs.** Both gateways have small REST APIs, called with `fetch`, and signatures
  are checked with `node:crypto`. That adds no runtime dependencies, and keeps the code we have
  to review short. The browser scripts are loaded from the gateways' own hosts, as they require,
  and the storefront's content security policy names those hosts.

### API and screens

- **Storefront GraphQL:**
  - `checkoutPreview` lists the payment methods available.
  - `placeOrder` takes `paymentMethod`.
  - New mutation `startPayment`.
  - `Order` gains `payment { method status }`.
- **Admin:** the order view shows the payment and its transaction log, under `order.view`.
- **Storefront:** checkout gains a payment method choice. A payment step follows placing the
  order, and the order page shows the payment's status and a "Pay now" for a pending payment.

## Consequences

- Buyers can pay by card, ACH or UPI in test mode. Terms keep working unchanged.
- Going live is a matter of configuration (live keys and `PAYMENTS_LIVE=true`), plus a
  second-review decision. There are no code changes.
- The webhooks are the API's first unauthenticated POST routes. They sit outside the
  trusted-origin guard and the session middleware, and are protected by their signatures, a body
  size limit and a rate limit.
- Tests:
  - Known-answer tests for both signature schemes, using the gateways' documented examples.
  - Webhook idempotency and amount checks.
  - A fake gateway server for the flow.
  - A manual run against both gateways' test modes, with test cards and the UPI test id.
- This is payments, so every pull request needs a second human reviewer under CLAUDE.md rule 4.
- Not in the pilot: live payments, saved cards, partial payments, manual capture, refunds from
  the admin, Authorize.Net and PayU.
