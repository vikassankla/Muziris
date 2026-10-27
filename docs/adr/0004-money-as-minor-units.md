# 0004: Money is integer minor units with exact decimal maths

- Status: accepted
- Date: 2026-10-27

## Context

Prices, GST and US sales tax must add up to the paisa or cent on every invoice. JavaScript numbers
are binary floating point and cannot represent most decimal amounts exactly.

## Decision

Money is a `bigint` count of minor units plus an ISO 4217 currency code. Quantities and rates
are exact decimals backed by `bigint`. Multiplying money by a quantity or rate rounds once, with
an explicit rounding mode. Splitting an amount (for example a discount across lines) uses
`allocate`, which never loses or creates a minor unit. Operations refuse to mix currencies.

## Consequences

- No float ever reaches a stored amount.
- API payloads carry amounts as decimal strings ("1250.50"), never as JSON numbers.
- Display formatting uses the website locale: en-IN gives lakh and crore grouping.
