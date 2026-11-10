# 0031: Feature toggles for quick order and shopping lists

- Status: proposed
- Date: 2026-11-10

## Context

ADR 0003 decided that feature toggles are boolean settings, resolved customer, customer group,
website, organization, global. ADR 0021 gave them their own section on the Settings page, but
none exist yet (`docs/status.md`, item 13). Vikas asked for them on 2026-11-10.

A toggle is worth having where a business may want a storefront feature off for a website or a
customer: a buyer who must not keep lists, or a website where quick order's CSV upload is not
wanted. The pilot's storefront has three such features.

## Decision

### The toggles

Three settings in the registry (`apps/api/src/settings.ts`), group "Features", editor
`boolean`, each allowed at customer, customer group, website, organization and global scope:

| Key                        | Default | What it turns off                                                       |
| -------------------------- | ------- | ----------------------------------------------------------------------- |
| `features.quick_order`     | on      | The quick order page and `productsBySkus`                               |
| `features.quick_order_csv` | on      | CSV upload on the quick order page (pasting stays)                      |
| `features.shopping_lists`  | on      | Shopping lists: the pages, every list query and mutation, list checkout |

All default to on, so nothing changes until an admin turns one off.

### Where they are enforced

- **The storefront API.** Each resolver behind a toggle reads it for the signed-in buyer's
  customer and website. When it is off, a query answers a GraphQL error with code
  `FEATURE_DISABLED`, and a mutation answers its refusal with code `feature_disabled`. The
  check is in the API, so a buyer cannot reach a feature by calling the API directly.
  `features.quick_order_csv` is the exception: the CSV file is read in the browser and never
  sent (item 10), and its rows reach the API exactly as pasted ones do. That toggle only hides
  the upload; it is a convenience, not a control.
- **The storefront app.** The `Shell` query gains a `features` field with `quickOrder`,
  `quickOrderCsv` and `shoppingLists`, resolved the same way. The app hides the links and
  buttons of a feature that is off, and a page reached by its address shows "This isn't
  available on your account".
- **The admin.** The Settings page shows the toggles in a "Features" section, as ADR 0021
  planned, with the same override and clear as other settings.

Adding a toggle later is one registry entry, one check in the API and one in the app. Each
new feature decides in its own ADR whether it needs one.

## Consequences

- Each toggled request reads one more setting; settings resolve in one indexed query (ADR 0003).
- `Shell` gains a field, so the persisted query registry changes with the storefront build.
- Turning shopping lists off hides lists; it deletes nothing, and turning them on again shows
  them as they were.
- Toggles steer what buyers may do, so the pull request needs a second human review under
  CLAUDE.md rule 4 (access control).

### Not chosen

- **Toggles in the storefront app only:** a buyer could still call the API.
- **A separate toggle table:** ADR 0003 already decided toggles are settings.
- **Toggles for checkout, search or payment methods:** checkout and search are the store
  itself; payment methods already have their own setting (ADR 0019).
