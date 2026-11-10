# 0030: A payments screen in the admin, with keys kept in the environment

- Status: proposed
- Date: 2026-11-10

## Context

Vikas asked for the payment gateway configuration in the admin (2026-11-10).

ADR 0019 keeps every gateway credential in the environment: `STRIPE_*`, `RAZORPAY_*` and
`PAYMENTS_LIVE`, read once at startup. Secrets never go into the database or the admin
settings, and never reach the browser. On 2026-11-10 Vikas chose to keep that: the keys stay in
the env file (`/etc/muziris/muziris.env` on the pilot VM, ADR 0029). An admin screen should show
the state of the gateways, not take their keys.

Today an admin cannot see, without a shell on the server:

- whether Stripe or Razorpay is configured, and in test or live mode;
- which webhook address to give each gateway's dashboard;
- whether webhooks arrive, and whether any were refused (`amount_mismatch`,
  `unknown_payment` in `payment_transaction`);
- which payment methods each website really offers. The Settings page warns about this since
  PR 62, but one setting at a time.

## Decision

### The API

`GET /admin/v1/payments/gateways`, under a new admin permission `payment.view` ("See payment
gateways, the methods each website offers, and webhook events"). It answers, per gateway
(Stripe, then Razorpay):

| Field                | What it is                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `configured`         | All the gateway's variables are set                                                             |
| `mode`               | `test` or `live`, from the key prefixes; null when not configured                               |
| `publicKey`          | The key the browser already gets (`pk_…`, `rzp_…` key id); null when not configured             |
| `variables`          | Each variable's name and whether it is set, never its value                                     |
| `currencies`         | The currencies it takes (Stripe USD, Razorpay INR, as `METHOD_CURRENCIES`)                      |
| `methods`            | The payment methods it provides (`stripe_card`, `stripe_ach`; `razorpay`)                       |
| `webhookUrl`         | `STOREFRONT_PUBLIC_URL` + `/webhooks/stripe` or `/webhooks/razorpay`, to paste in its dashboard |
| `lastEvent`          | The latest webhook event: received at, type, outcome                                            |
| `refusedEvents7Days` | Events in the last 7 days with outcome `amount_mismatch` or `unknown_payment`                   |

And per website: the methods listed in `payment.methods` at website scope (or inherited), the
methods checkout offers there today (`availableMethods`), and the warnings PR 62 already
computes.

Secret values are never read into the answer. A test checks that no secret key, key secret or
webhook secret appears anywhere in the response body.

### The screen

System > Payments, in the admin sidebar under System, for admins with `payment.view`:

- one card per gateway: Configured or Not configured, Test or Live, the public key, the webhook
  address with a copy button, the last webhook event and refused events in the last 7 days;
- "How to change the keys": the variable names, and the steps from `docs/install.md` (edit the
  env file, then restart with `deploy/muziris up -d`). The screen has no key fields;
- a table of websites and the methods each one offers, with the warnings, and a link to the
  payment methods setting on the Settings page to change them.

Nothing on the screen changes anything, so it needs no `manage` permission.

## Consequences

- An admin can check payments without a shell, and set up webhooks from the screen.
- Changing a key still needs the server and a restart. That is the cost of keeping secrets out
  of the database, accepted for the pilot.
- A new permission is a change to access control, so the pull request needs a second human
  review under CLAUDE.md rule 4. The built-in administrator role gets it, as it gets every
  permission.
- The public key and the webhook address are shown. Both are public by design: the browser
  already receives the key, and the address is the storefront's own.

### Not chosen

- **Keys entered in the admin and stored encrypted:** declined by Vikas on 2026-11-10. It
  would reverse ADR 0019 and need a master key, rotation and an audit of who saw or changed
  keys.
- **A "check keys" button that calls the gateway:** useful, but it makes a call to Stripe or
  Razorpay from an admin click. Left for later; the webhook status shows most of the same.
