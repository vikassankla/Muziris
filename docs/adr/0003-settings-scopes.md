# 0003: Settings resolve from the customer up to global

- Status: accepted
- Date: 2026-10-27

## Context

B2B behaviour varies by website and by customer: payment terms, minimum order value, whether
guest checkout is on. Admins need to set a value once at a broad level and override it where
needed, and to see where an effective value comes from.

## Decision

Every setting is declared in code with a key, a zod schema, a default and the scopes where it may
be set. Stored values live in `platform_config_value`, one row per scope and key. Resolution
walks customer, customer group, website, organization, global, and returns the first value found
together with its source. A stored value that fails its schema raises an error instead of falling
back silently. Values at scopes the definition does not allow are ignored.

## Consequences

- Feature toggles are boolean settings and use the same mechanism.
- Reading a setting costs one indexed query for all scopes at once.
- Changing a setting's schema needs a migration of stored values, or reads will fail loudly.
