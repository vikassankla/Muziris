# 0009: Products, product units and categories live in a catalog module

- Status: proposed
- Date: 2026-10-28

## Context

Week 2 of the pilot plan needs a catalog: simple products with a SKU, name and status; the
product units they are sold in (each, box of 10, kg) with their decimal precision; categories in
a tree; and product attributes. The glossary names three product types (simple, configurable,
kit); only simple products are in the pilot. Week 3's price lists are "by product, unit,
currency and minimum quantity", visibility and search build on products and categories, and
shopping lists and orders (week 4) carry quantities in a product unit. Quantities must be exact
decimals, never JavaScript numbers (ADR 0004). Admin permissions `product.view` and
`product.manage` already exist in access control (ADR 0006).

## Decision

Catalog is a new module, `modules/catalog` (`@muziris/catalog`), owning the tables prefixed
`catalog_`: `catalog_product_unit`, `catalog_category`, `catalog_product` and
`catalog_product_sold_in`. It depends only on `@muziris/db` and `@muziris/money`.

- **Product units** are a short list the organization keeps, keyed by a lower-case code
  (`each`, `box_10`, `kg`) with a name and a precision from 0 to 6, checked in code and in the
  database. Precision cannot be changed after creation, because quantities already recorded in
  the unit might no longer fit; a different precision means a new product unit. Conversion
  between units (a box of 10 is 10 each) is not in this decision.
- **Quantities** are `Decimal` values from `@muziris/money`, read with `parseQuantity` (or
  `quantitySchema` at an HTTP boundary) at the unit's precision. Without a rounding mode, a
  quantity with more significant decimals than the unit allows is refused, so a buyer's input is
  never changed silently; with one, it is rounded once, there. A quantity must be greater than
  zero and below 10^12, so it fits `numeric(18, 6)` at any precision. JSON numbers are refused.
- **A product is sold in one or more product units**, one of them primary, stored in
  `catalog_product_sold_in`. A partial unique index allows at most one primary row per product;
  the module writes the units only in a transaction that locks the product row, so there is
  always exactly one. A product unit that a product is sold in cannot be deleted.
- **Products** have a SKU, unique regardless of letter case (a unique index on `lower(sku)`),
  a name, a status (`enabled` or `disabled`, new products start disabled), an optional category
  and attributes. A `type` column exists with only `simple` allowed, in code and in a database
  check; configurable and kit products widen both when they are built. A product is in at most
  one category.
- **Attributes** are a JSONB object (checked by the database) validated with zod in code. Until
  attribute definitions exist, keys are lower-case identifiers and values are text, true or
  false, or a list of texts; at most 100 attributes. Measurements are decimal strings, so no
  binary float is stored. Reading stored attributes that no longer match the schema throws, as
  stored settings do (ADR 0003).
- **Categories** form a tree through `parent_id`, ordered among siblings by `position`, then
  name. Cycles are refused as for customers (ADR 0008): the database refuses a category as its
  own parent, and `setCategoryParent` takes a transaction-scoped advisory lock and checks the new
  parent is not below the category. The walk is a recursive CTE with the `CYCLE` clause.
  `descendantCategoryIds` and `categorySubtreeIds` return `SQL` selects for visibility and search
  to use. A category with subcategories or products cannot be deleted.
- **Admin API** under `/admin/v1/catalog`: product units, categories (tree, create, rename,
  move, delete) and products (list by SKU page, create, read, edit, set units). Reads need
  `product.view` and changes `product.manage`, through `requirePermission`. The catalog is the
  organization's own data, so module functions are not buyer-scoped; what a buyer may see is
  decided by visibility in week 3.

## Consequences

- Price lists, visibility, search and shopping lists can refer to products by id, product units
  by code and categories by id, and check quantities with the unit's precision.
- Names are single-language for now. Localized names and descriptions need translation tables
  when a website has more than one language.
- Attribute values are untyped text until attribute definitions (type, unit, filterable) are
  built; search filters will need them. Tightening the schema then needs a migration of stored
  values, or reads fail loudly.
- Unit conversion, per-product precision, and minimum or step quantities are not built. Price
  lists in week 3 price each product unit separately.
- Products are listed by SKU with keyset paging; text search waits for PostgreSQL search in
  week 3.
- Product images and files wait for object storage work.
