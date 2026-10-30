# 0017: Tax engine for India GST and US sales tax

- Status: proposed
- Date: 2026-10-30

## Context

Checkout (ADR 0016) computes tax through a `TaxProvider` and, in the API, refuses with
`TAX_NOT_CONFIGURED` until one exists. The pilot sells in India and the US (selling to all
countries is a later phase). ADR 0004 requires tax to add up to the paisa or cent. CLAUDE.md asks
for known-answer tables for tax and a second human reviewer for any change to tax.

What exists: India and US addresses with GST state codes, PIN and ZIP codes and an optional
GSTIN (ADR 0008); a website's country and currency (ADR 0003); settings resolved customer to
global. What does not: tax codes on products, the seller's tax registrations, any rates, and a
way for tax to refuse a checkout.

The requirements spec names HSN and SAC codes, GST state codes, GSTIN and ZIP codes but leaves the
rules below to this ADR. Points marked **(check)** are choices a tax adviser should confirm before
the pilot goes live.

## Decision

A new `tax` module owns tax registrations, rates, US exemptions and the provider checkout calls,
`tableTaxProvider(db)`. It never reads another module's tables: everything it needs comes in the
`TaxRequest`. Rates are data an admin enters, not code: GST and US rates change by notification
and ballot, and a release must not be needed to follow them.

**What the request carries.** `TaxRequest` lines gain each product's tax codes, which orders reads
from the catalog with the product, and the request gains the website's country and time zone.
The catalog gains two optional fields on products, because one product can be sold on an Indian
and a US website: `hsn_sac_code`, an HSN code (4, 6 or 8 digits) or a SAC code (6 digits
starting 99), and `us_tax_category` (`general` or `exempt`). The provider picks the regime from
the website's country: IN is GST, US is sales tax.

**Refusing.** `TaxResult` gains `problems`, each with a line number (or none for the whole order)
and a code. Orders turns them into a new checkout refusal, `tax_problems`, so a product without a
tax code is never sold untaxed. Codes: `no_tax_code`, `no_rate` (no rate covers the code on that
day), `no_registration` (India: the website has no GST registration) and `cross_border` (the ship
to country is not the website's; exports are not in the pilot).

**India GST.**

- Registration: the website's GSTIN, whose first two digits are its state code.
- Rate: the GST rate table maps an HSN or SAC prefix to a rate, with a start date and an optional
  end date. The longest prefix that covers the code on the day wins (`8482` covers
  `84821011`), so an admin can enter rates at chapter, heading or full-code level. No rates
  are shipped: the admin enters them, and the demo catalog brings its own.
- Place of supply: the shipping address's state. The same state as the registration charges
  CGST and SGST at half the rate each. A union territory without a legislature (codes 04, 26,
  31, 35 and 38) charges UTGST instead of SGST. Any other state charges IGST at the full rate.
- Rounding: each tax on each line, half up to the paisa. CGST and SGST are each computed from
  the taxable value, so they can differ by a paisa from half of IGST. **(check)**
- Shipping: taxed as part of the supply, at the highest rate among the order's lines (the
  principal supply is often unclear on a mixed order, and the highest rate never under-collects).
  **(check)**
- The buyer's GSTIN does not change the tax. It is copied to the order with the addresses, as
  now. No reverse charge, composition scheme or e-invoicing (IRN) in the pilot.

**US sales tax.**

- Registrations: the states where the seller collects (nexus), each with its permit number.
  An order shipped to any other state has no tax.
- Rate: destination based. The US rate table holds a combined rate (state plus local) per state,
  with optional rows for a ZIP code or ZIP prefix; the longest match wins, then the state row.
  Each row says whether shipping is taxable there. Like GST rates, rows have dates, and the
  admin enters or imports them from the state's published tables. Address-level rooftop
  accuracy needs a rate service, which can replace this provider later. **(check)**
- Taxability: the US tax category `exempt` charges nothing; every other category, and none,
  is taxable at the rate.
- Exemptions: a customer can hold an exemption certificate for a state (number, optional expiry).
  A valid one makes the order tax free in that state, and the order records the certificate
  number on its tax lines. Most B2B resale buyers have one.
- Rounding: each line half up to the cent. **(check)**

**What an order keeps.** Tax lines already copy name, rate, taxable amount and amount. Orders also
copy the seller's registration number used (GSTIN or US permit) and, for an exempt order, the
certificate number, so an invoice can be printed from the order alone.

**Discounts.** The pilot has none. When order discounts arrive, the provider spreads them over
the lines by net amount with `allocate` before computing tax, so no paisa is lost.

**Admin.** New admin permissions `tax.view` and `tax.manage`. Routes under `/admin/v1/tax`:
registrations per website, GST rates, US rates (with a CSV import), and customer exemptions. The
product tax code is edited with the product, under the catalog routes. Admin screens follow in
their own pull request.

**Wiring.** `server.ts` passes `tableTaxProvider(db)` as the API's tax calculator, so
`TAX_NOT_CONFIGURED` no longer appears; a website without rates refuses with `tax_problems`
instead, naming the lines.

## Consequences

- Checkout charges real GST and US sales tax, and refuses rather than under-charging when a
  code, rate or registration is missing.
- Following a rate change is data entry, with dates, so a change can be entered before it starts.
- Rates being entered by hand is a risk: a wrong rate charges wrong tax. Rate changes are logged
  with the admin who made them, and the pilot's rates need a second person to check them.
- A tax service (for rooftop US rates, or GST e-invoicing) can replace the provider without
  changing orders, because orders only knows the `TaxProvider` interface.
- Catalog, orders and the API change, and this is tax: every pull request needs a second human
  reviewer under CLAUDE.md rule 4.
- Not in the pilot: exports and SEZ supplies, reverse charge, cess, TDS and TCS, e-invoicing and
  e-way bills, US use tax, marketplace facilitator rules, and tax-inclusive prices.
