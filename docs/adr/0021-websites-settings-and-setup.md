# 0021: Websites, settings and first-run setup in the admin

- Status: proposed
- Date: 2026-11-02

## Context

The pilot can now take, pay for and email about orders, but an operator cannot set up a shop
without writing code:

- **No organization or website can be created outside the tests.** `createOrganization` and
  `createWebsite` (platform) have no caller in `apps/`. A fresh install has no storefront to
  serve.
- **Settings are changed only in code.** Checkout reads `payment.term_days`,
  `payment.methods`, `shipping.flat_rate`, `orders.number_prefix`,
  `checkout.minimum_order_minor`, `notifications.order_email` and others through `getSetting`.
  `setSetting` exists, but has no route. The permissions `website.view`, `website.manage`,
  `setting.view` and `setting.manage` exist and guard nothing yet.
- **The admin's website switcher is a placeholder** that only sets how money and dates show.
- **Invited buyers get no buyer role**, so an admin assigns one by hand after each acceptance.
  Choosing a default is an open item (ADR 0006, ADR 0008).
- **No product units are seeded**, so an admin must create `each` before the first product.

The Websites and Settings boards in `docs/design/admin` show the screens. Settings resolve
customer, customer group, website, organization, then global (ADR 0003).

## Decision

### First-run setup

`pnpm --filter @muziris/api setup --organization "Acme Industrial Supply"` prepares an empty
install. It is idempotent: each step runs only if its result is missing.

1. It creates the organization. One install runs one business (README), so a second
   organization is refused.
2. It seeds the standard product units: `each` and `pack` (precision 0); `kg`, `m` and `l`
   (precision 3). An admin can add others in the admin app as now.
3. It prints the next steps: `admin:create`, then sign in and create the first website.

The CLI creates no website, so its country, currency and time zone are chosen in the admin
app, where they are explained.

### Websites

**The API**, under `/admin/v1/websites`. Reads need `website.view`; changes need
`website.manage`.

- Endpoints: list, create, read, and edit.
- **Create** takes a code, name, country, default currency, default locale, time zone and
  unit system. In the pilot:
  - the country is IN or US;
  - the currency is any ISO 4217 code `@muziris/money` knows;
  - the locale is en-IN or en-US;
  - the time zone must be an IANA name that `Intl` accepts.
- **Code, country and currency are fixed after creation.** The code names the website in the
  storefront's `Muziris-Website` header. The country decides tax (ADR 0017). Price lists,
  orders and payments are all in the currency. The board's "locked: N orders use this
  currency" becomes "set when the website was created".
- **Name, locale, time zone, unit system and active can be changed.** An inactive website
  refuses storefront sign-in and checkout. Its orders stay readable.

**The screen** follows the Websites board: a list, a create sheet, and an edit page with a
"how this website formats" panel. The panel uses the admin's existing `format.ts`.

**The website switcher becomes real.** It lists active websites from the API, starting with
the first one. The choice is kept in memory, so a reload starts again from the first website.
The 2026-10-29 decision allows only UI preferences in browser storage. Remembering the
website there would need that decision changed, so this ADR leaves it out.

### Settings

**A registry.** Each setting an admin may change is listed once in `apps/api/src/settings.ts`,
with its definition from its module, a group (Checkout, Payments, Shipping, Orders, Emails,
Catalog, Tax), a label and an editor kind:

- integer;
- money amount, in the website's currency;
- text;
- email address;
- one value from a list, or several values from a list (such as payment methods);
- on/off;
- buyer role.

A setting not in the registry cannot be changed through the API. Secrets are environment
variables, never settings (ADR 0019, ADR 0020).

**The API**, under `/admin/v1/settings`. Reads need `setting.view`; changes need
`setting.manage`.

- `GET ?websiteId=&customerGroupId=&customerId=` returns every registered setting with its
  effective value for that context. Each value says which scope it comes from.
- `PUT /:key` takes a value and a scope (customer, customer group, website, organization or
  global). It checks that:
  - the scope is one the definition allows;
  - the value passes the definition's zod schema;
  - a referenced buyer role, customer or customer group exists.
- `DELETE /:key?scope=&scopeId=` clears an override, so the value falls back to the next
  scope.
- **Each change is logged with who made it and when.** The config table gains
  `updated_by_user_id` (migration). Refusals are RFC 9457 problems:
  - `setting_not_found`
  - `setting_scope_not_allowed`
  - `setting_invalid_value`

**The screen** follows the Settings board:

- A context picker: website, then customer group, then customer.
- Settings grouped as in the registry. Each shows its effective value and its source, with
  "Override…" and "Clear override".
- An "only overridden" filter.
- Feature toggles in their own section.

The board's "also apply to its N subsidiaries" is not built: settings do not inherit down the
customer hierarchy (ADR 0003).

### The default buyer role

- **A setting.** `customers.default_buyer_role` holds the buyer role given to invited buyers,
  at website or organization scope. Its default is none, as today.
- **The invite dialog.** It gains a buyer role picker, prefilled from the setting, where the
  admin can choose another role or none.
- **Assigning it.** The invitation stores the chosen role (`buyer_role_id`, nullable, a
  migration in customers with no foreign key into access). When the invitation is accepted,
  the API assigns that role in the same transaction that creates the buyer user. A role
  deleted in the meantime is skipped and logged.

### As built

Where the build differs from the plan above, or settles something it left open:

- **Setup** is `pnpm --filter @muziris/api setup --organization "<name>"`. It creates the
  organization when there is none and adds the standard product units (each and pack, whole
  numbers; kg, m and l to 3 decimal places) that are missing. Run again, it changes nothing.
  Without an organization and without `--organization` it stops and says so.
- **Listing websites needs only a session.** Every admin screen formats money and dates by
  the website in the top bar, so any signed-in admin may list websites. Reading one needs
  `website.view`; creating or changing one needs `website.manage`.
- **Pilot values only.** A website's country is IN or US, its locale en-IN or en-US and its
  currency INR or USD, because the admin and storefront format only these and the gateways take
  only these. The API refuses anything else.
- **An inactive website** answers as not found on the storefront API, as if it did not exist.
  Buyer sign-in itself is not per website, so a buyer can still sign in.
- **Websites are edited in a sheet** on `/websites`, not a page of their own. The sheet shows how
  the website formats an amount, a date and a quantity.
- **The registry** is `apps/api/src/settings.ts` (`ADMIN_SETTINGS`), with a "Customers" group
  for the default buyer role. Feature toggles do not exist yet, so the Settings screen has no
  toggles section.
- **Settings screen.** It starts from the top bar's website; a customer group, or a customer
  (from the customer page's "Settings for this customer"), narrows it. A customer brings its own
  group. "Change" overrides at one scope of that context that the setting allows; "Clear"
  removes the override the value comes from, when that scope is in the context.
- **Who changed it.** `platform_config_value.updated_by_user_id` (migration `0017`) records
  the admin. Changes are logged by key and scope, never by value, because a value can be an
  email address.
- **The default buyer role** (`customers.default_buyer_role`, website or organization) is read
  for the organization and the storefront website (`STOREFRONT_WEBSITE`) when an invitation
  leaves the role out. The invitation stores it (`customer_invitation.buyer_role_id`,
  migration `0018`), and acceptance grants it inside the same transaction through a hook. A role
  deleted in the meantime is skipped and logged as `auth.invitation_role_missing`.
- **Fixed in passing.** The order emails' payment method labels named a `stripe` method that
  does not exist; they now cover `stripe_card` and `stripe_ach`, typed so a new method cannot
  be missed.

## Consequences

- A fresh install can be set up end to end: the setup CLI, then `admin:create`, then the first
  website and its settings in the admin app.
- The website switcher shows real websites. Amounts and dates follow the website's own
  locale and time zone.
- Settings can be changed without a deploy, and each change records who made it.
- Invited buyers can order as soon as they accept, without waiting for an admin.
- **Second reviewer.** This changes access control (buyer roles assigned on acceptance) and
  settings that steer payments, so its pull requests need a second human reviewer under
  CLAUDE.md rule 4.
- Not in this ADR: creating more organizations; changing a website's currency; the
  subsidiaries option on settings; remembering the selected website across reloads; admin
  users and Home dashboard widgets.
