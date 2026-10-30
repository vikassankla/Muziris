import {
  findProductBySkuWithin,
  findProductsWithin,
  listCategoriesWithin,
  listProductsWithin,
  parseQuantity,
  quantityToString,
  type Category,
  type Product,
  type ProductUnit,
} from '@muziris/catalog';
import { listAddressesForBuyer, listCustomersForBuyer, type Address } from '@muziris/customers';
import type { Database } from '@muziris/db';
import type { AuthenticatedUser } from '@muziris/identity';
import { toDecimalString, type CurrencyCode, type Decimal, type Money } from '@muziris/money';
import {
  findOrderForBuyer,
  listOrdersForBuyer,
  ORDER_STEPS,
  placeOrder,
  placeOrderRequestSchema,
  previewCheckout,
  checkoutRequestSchema,
  type CheckoutDependencies,
  type CheckoutRefusal,
  type LineProblem,
  type Order,
  type OrderAddress,
  type OrderSummary,
  type Totals,
  type TotalsLine,
  type TaxLine,
} from '@muziris/orders';
import type { Website } from '@muziris/platform';
import { findPricesForBuyer, type PriceLookup } from '@muziris/pricing';
import { MATCHES, searchProductsForBuyer, type SearchHit } from '@muziris/search';
import {
  visibleCategoryIdsForBuyer,
  visibleProductIdsForBuyer,
  type BuyerOnWebsite,
} from '@muziris/visibility';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLNullableInputType,
  type GraphQLNamedOutputType,
  type GraphQLNullableOutputType,
} from 'graphql';
import { z } from 'zod';
import type { FieldCostExtensions } from './limits.js';
import { createLoader, type Loader } from './loader.js';

// The storefront schema of ADR 0014. Every resolver reads through a module's buyer-scoped public
// function: products and categories within visibility's selects, prices from the combined price
// list for the signed-in buyer, search through searchProductsForBuyer. Nothing here decides what
// a buyer may see.

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;

interface PriceKey {
  productId: string;
  unitCode: string;
  quantity: Decimal;
}

export interface StorefrontContext {
  db: Database;
  now: Date;
  user: AuthenticatedUser;
  website: Website;
  buyer: BuyerOnWebsite;
  /** Tax and the other checkout providers; null until a tax calculator is set up (ADR 0017). */
  checkout: CheckoutDependencies | null;
  loaders: {
    product: Loader<string, Product | null>;
    /** Every category the buyer may see, read once per request. */
    categories: () => Promise<ReadonlyMap<string, Category>>;
    price: Loader<PriceKey, PriceLookup>;
  };
}

/** Builds a request's context, with loaders that batch reads for the request's lifetime. */
export function createContext(input: {
  db: Database;
  now: Date;
  user: AuthenticatedUser;
  website: Website;
  checkout: CheckoutDependencies | null;
}): StorefrontContext {
  const { db, now, user, website, checkout } = input;
  const buyer: BuyerOnWebsite = { buyerUserId: user.id, websiteId: website.id };
  let categories: Promise<ReadonlyMap<string, Category>> | undefined;
  return {
    db,
    now,
    user,
    website,
    buyer,
    checkout,
    loaders: {
      product: createLoader<string, Product | null>(
        async (ids) => {
          const found = await findProductsWithin(db, visibleProductIdsForBuyer(buyer), ids);
          return new Map(found.map((p) => [p.id, p]));
        },
        (id) => id,
        null,
      ),
      categories: () => {
        categories ??= listCategoriesWithin(db, visibleCategoryIdsForBuyer(buyer)).then(
          (rows) => new Map(rows.map((c) => [c.id, c])),
        );
        return categories;
      },
      price: createLoader<PriceKey, PriceLookup>(
        async (keys) => {
          const prices = await findPricesForBuyer(db, {
            buyerUserId: buyer.buyerUserId,
            websiteId: website.id,
            currency: website.defaultCurrency as CurrencyCode,
            now,
            items: keys,
          });
          const byKey = new Map<string, PriceLookup>();
          keys.forEach((key, index) => {
            const price = prices[index];
            if (price === undefined) throw new Error('Price lookup lost an item');
            byKey.set(priceKeyId(key), price);
          });
          return byKey;
        },
        priceKeyId,
        { found: false, reason: 'no_price' },
      ),
    },
  };
}

function priceKeyId(key: PriceKey): string {
  return `${key.productId}|${key.unitCode}|${quantityToString(key.quantity)}`;
}

/** An error the buyer may see, with a stable code. */
function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

const uuid = z.uuid();

function nonNull<T extends GraphQLNullableOutputType>(type: T): GraphQLNonNull<T> {
  return new GraphQLNonNull(type);
}

function listOf<T extends GraphQLNamedOutputType>(type: T) {
  return nonNull(new GraphQLList(nonNull(type)));
}

type Field<TSource> = GraphQLFieldConfig<TSource, StorefrontContext>;

function pageSize(first: unknown): number {
  const parsed = z.int().min(1).max(PAGE_SIZE_MAX).safeParse(first);
  if (!parsed.success) throw badInput(`first must be a whole number from 1 to ${PAGE_SIZE_MAX}`);
  return parsed.data;
}

const firstArg = {
  type: GraphQLInt,
  default: { value: PAGE_SIZE_DEFAULT },
  description: `How many to return, at most ${PAGE_SIZE_MAX}.`,
};

const WebsiteType = new GraphQLObjectType<Website, StorefrontContext>({
  name: 'Website',
  description: 'The storefront this request is for, named by the Muziris-Website header.',
  fields: {
    code: { type: nonNull(GraphQLString) },
    name: { type: nonNull(GraphQLString) },
    countryCode: { type: nonNull(GraphQLString) },
    currency: { type: nonNull(GraphQLString), resolve: (w) => w.defaultCurrency },
    locale: { type: nonNull(GraphQLString), resolve: (w) => w.defaultLocale },
    timeZone: { type: nonNull(GraphQLString) },
    unitSystem: { type: nonNull(GraphQLString) },
  },
});

const AddressType = new GraphQLObjectType<Address, StorefrontContext>({
  name: 'Address',
  description: "One of the customer's billing or shipping addresses.",
  fields: {
    id: { type: nonNull(GraphQLID) },
    label: { type: nonNull(GraphQLString) },
    countryCode: { type: nonNull(GraphQLString) },
    line1: { type: nonNull(GraphQLString) },
    line2: { type: GraphQLString },
    city: { type: nonNull(GraphQLString) },
    regionCode: {
      type: nonNull(GraphQLString),
      description: 'India: the two-digit GST state code. US: the two-letter state code.',
    },
    postalCode: { type: nonNull(GraphQLString) },
    gstin: { type: GraphQLString },
    isDefaultBilling: { type: nonNull(GraphQLBoolean) },
    isDefaultShipping: { type: nonNull(GraphQLBoolean) },
  },
});

const CustomerType = new GraphQLObjectType<{ id: string; name: string }, StorefrontContext>({
  name: 'Customer',
  description: 'The company the buyer user buys for.',
  fields: {
    id: { type: nonNull(GraphQLID) },
    name: { type: nonNull(GraphQLString) },
    addresses: {
      type: listOf(AddressType),
      description: 'Its addresses, to bill and ship an order to.',
      extensions: { listSize: 20 } satisfies FieldCostExtensions,
      resolve: (customer, _args, ctx) =>
        listAddressesForBuyer(
          ctx.db,
          { buyerUserId: ctx.user.id, reach: 'my_customer' },
          customer.id,
        ),
    },
  },
});

const ViewerType = new GraphQLObjectType<AuthenticatedUser, StorefrontContext>({
  name: 'Viewer',
  description: 'The signed-in buyer user.',
  fields: {
    id: { type: nonNull(GraphQLID) },
    email: { type: nonNull(GraphQLString) },
    displayName: { type: nonNull(GraphQLString) },
    customer: {
      type: nonNull(CustomerType),
      resolve: async (user, _args, ctx) => {
        const [own] = await listCustomersForBuyer(ctx.db, {
          buyerUserId: user.id,
          reach: 'my_customer',
        });
        if (!own) throw new Error('A signed-in buyer user has no customer');
        return own;
      },
    },
  },
});

const CategoryType = new GraphQLObjectType<Category, StorefrontContext>({
  name: 'Category',
  fields: {
    id: { type: nonNull(GraphQLID) },
    code: { type: nonNull(GraphQLString) },
    name: { type: nonNull(GraphQLString) },
    parentId: {
      type: GraphQLID,
      description: 'Null at the top, and when the buyer may not see the parent.',
      resolve: async (c, _args, ctx) =>
        c.parentId !== null && (await ctx.loaders.categories()).has(c.parentId) ? c.parentId : null,
    },
    position: { type: nonNull(GraphQLInt), description: 'Order among siblings, lowest first.' },
  },
});

const ProductUnitType = new GraphQLObjectType<ProductUnit, StorefrontContext>({
  name: 'ProductUnit',
  fields: {
    code: { type: nonNull(GraphQLString) },
    name: { type: nonNull(GraphQLString) },
    precision: {
      type: nonNull(GraphQLInt),
      description: 'Digits a quantity in this unit may have after the decimal point.',
    },
  },
});

const AttributeType = new GraphQLObjectType<{ key: string; values: string[] }, StorefrontContext>({
  name: 'Attribute',
  fields: {
    key: { type: nonNull(GraphQLString) },
    values: {
      type: listOf(GraphQLString),
      description: 'One value, or several for a list; true and false are "true" and "false".',
    },
  },
});

const MoneyType = new GraphQLObjectType<
  { minor: bigint; currency: CurrencyCode },
  StorefrontContext
>({
  name: 'Money',
  fields: {
    amount: {
      type: nonNull(GraphQLString),
      description: 'A decimal string in major units, for example "4.86".',
      resolve: (m) => toDecimalString(m),
    },
    minorUnits: {
      type: nonNull(GraphQLString),
      description: 'The amount in minor units (paise, cents), as a string of digits.',
      resolve: (m) => m.minor.toString(),
    },
    currency: { type: nonNull(GraphQLString) },
  },
});

interface PriceSource {
  unitPrice: { minor: bigint; currency: CurrencyCode };
  minQuantity: string;
  unitCode: string;
  quantity: Decimal;
}

const PriceType = new GraphQLObjectType<PriceSource, StorefrontContext>({
  name: 'Price',
  description: "The buyer's price from their combined price list.",
  fields: {
    unitPrice: { type: nonNull(MoneyType) },
    unitCode: { type: nonNull(GraphQLString) },
    quantity: {
      type: nonNull(GraphQLString),
      description: 'The quantity the price is for.',
      resolve: (p) => quantityToString(p.quantity),
    },
    minQuantity: {
      type: nonNull(GraphQLString),
      description: 'The smallest quantity the price applies to (its tier).',
    },
  },
});

const ProductType: GraphQLObjectType<Product, StorefrontContext> = new GraphQLObjectType<
  Product,
  StorefrontContext
>({
  name: 'Product',
  fields: () => ({
    id: { type: nonNull(GraphQLID) },
    sku: { type: nonNull(GraphQLString) },
    name: { type: nonNull(GraphQLString) },
    category: {
      type: CategoryType,
      description: 'Null when the product has none, or the buyer may not see it.',
      resolve: async (p, _args, ctx) =>
        p.categoryId === null ? null : ((await ctx.loaders.categories()).get(p.categoryId) ?? null),
    },
    attributes: {
      type: listOf(AttributeType),
      extensions: { listSize: 10 } satisfies FieldCostExtensions,
      resolve: (p) =>
        Object.entries(p.attributes)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => ({
            key,
            values: Array.isArray(value) ? value : [String(value)],
          })),
    },
    primaryUnit: {
      type: nonNull(ProductUnitType),
      resolve: (p) => {
        const unit = p.units.find((u) => u.code === p.primaryUnitCode);
        if (!unit) throw new Error(`Product ${p.id} has no primary unit`);
        return unit;
      },
    },
    units: {
      type: listOf(ProductUnitType),
      description: 'Every product unit the product is sold in, the primary one first.',
      extensions: { listSize: 5 } satisfies FieldCostExtensions,
    },
    price: {
      type: PriceType,
      description:
        'The price for a quantity in a product unit, or null when the buyer has no price for it.',
      args: {
        unitCode: { type: GraphQLString, description: 'Defaults to the primary unit.' },
        quantity: {
          type: GraphQLString,
          default: { value: '1' },
          description: "A decimal string at the unit's precision.",
        },
      },
      resolve: async (p, args: { unitCode?: string | null; quantity?: string | null }, ctx) => {
        const unitCode = args.unitCode ?? p.primaryUnitCode;
        const unit = p.units.find((u) => u.code === unitCode);
        if (!unit) throw badInput(`The product is not sold in ${unitCode}`);
        let quantity: Decimal;
        try {
          quantity = parseQuantity(args.quantity ?? '1', unit);
        } catch {
          throw badInput(
            `The quantity must be greater than zero, with at most ${unit.precision} decimals`,
          );
        }
        const lookup = await ctx.loaders.price.load({ productId: p.id, unitCode, quantity });
        if (!lookup.found) return null;
        return {
          unitPrice: lookup.unitPrice,
          minQuantity: lookup.minQuantity,
          unitCode,
          quantity,
        } satisfies PriceSource;
      },
    },
  }),
});

const ProductPageType = new GraphQLObjectType<
  { nodes: Product[]; nextAfter: string | null },
  StorefrontContext
>({
  name: 'ProductPage',
  fields: {
    nodes: { type: listOf(ProductType) },
    nextAfter: {
      type: GraphQLString,
      description: 'Pass as after to read the next page; null on the last page.',
    },
  },
});

const SearchMatchType = new GraphQLEnumType({
  name: 'SearchMatch',
  description: 'How a product matched, best first.',
  values: Object.fromEntries(MATCHES.map((m) => [m.toUpperCase(), { value: m }])),
});

const SearchHitType = new GraphQLObjectType<SearchHit, StorefrontContext>({
  name: 'SearchHit',
  fields: {
    match: { type: nonNull(SearchMatchType) },
    product: {
      type: nonNull(ProductType),
      resolve: async (hit, _args, ctx) => {
        const product = await ctx.loaders.product.load(hit.productId);
        if (!product) throw new Error('A search hit is not readable for the same buyer');
        return product;
      },
    },
  },
});

const SearchResultsType = new GraphQLObjectType<
  { nodes: SearchHit[]; nextOffset: number | null },
  StorefrontContext
>({
  name: 'SearchResults',
  fields: {
    nodes: { type: listOf(SearchHitType) },
    nextOffset: {
      type: GraphQLInt,
      description: 'Pass as offset to read the next page; null on the last page.',
    },
  },
});

// Checkout and orders (ADR 0016). Refusals are data, not errors: each has a stable code and a
// message the buyer may see, and prices_changed carries the new totals to show.

function enumOf(name: string, values: readonly string[], description?: string) {
  return new GraphQLEnumType({
    name,
    ...(description === undefined ? {} : { description }),
    values: Object.fromEntries(values.map((v) => [v.toUpperCase(), { value: v }])),
  });
}

const OrderStepType = enumOf('OrderStep', ORDER_STEPS, 'Where an order is in its workflow.');

/** A line as checkout priced it, or as the order keeps it: the two have the same fields. */
type LineSource = Pick<
  TotalsLine,
  | 'lineNo'
  | 'productId'
  | 'sku'
  | 'productName'
  | 'unitCode'
  | 'unitName'
  | 'quantity'
  | 'unitPrice'
  | 'subtotal'
  | 'discount'
  | 'net'
  | 'taxCode'
>;

const OrderLineType = new GraphQLObjectType<LineSource, StorefrontContext>({
  name: 'OrderLine',
  description: 'A line of a checkout or an order: what was bought and its price.',
  fields: {
    lineNo: { type: nonNull(GraphQLInt), description: '1, 2, 3 in the order the buyer listed.' },
    productId: { type: nonNull(GraphQLID) },
    sku: { type: nonNull(GraphQLString) },
    productName: { type: nonNull(GraphQLString) },
    unitCode: { type: nonNull(GraphQLString) },
    unitName: { type: nonNull(GraphQLString) },
    quantity: { type: nonNull(GraphQLString), resolve: (l) => quantityToString(l.quantity) },
    unitPrice: { type: nonNull(MoneyType) },
    subtotal: { type: nonNull(MoneyType), description: 'Unit price times quantity.' },
    discount: { type: nonNull(MoneyType) },
    net: { type: nonNull(MoneyType), description: 'Subtotal less discount, before tax.' },
    taxCode: { type: GraphQLString, description: 'HSN or SAC in India.' },
  },
});

const TaxType = new GraphQLObjectType<
  Pick<TaxLine, 'lineNo' | 'name' | 'rate' | 'taxable' | 'amount'>,
  StorefrontContext
>({
  name: 'Tax',
  description: 'One tax charged: on a line, or on shipping when lineNo is null.',
  fields: {
    lineNo: { type: GraphQLInt },
    name: { type: nonNull(GraphQLString), description: 'For example CGST, SGST or IGST.' },
    rate: { type: nonNull(GraphQLString), description: 'A decimal fraction: "0.09" is 9%.' },
    taxable: { type: nonNull(MoneyType) },
    amount: { type: nonNull(MoneyType) },
  },
});

/** The totals fields a checkout and an order share. */
interface TotalsSource {
  currency: CurrencyCode;
  lines: readonly LineSource[];
  taxes: readonly Pick<TaxLine, 'lineNo' | 'name' | 'rate' | 'taxable' | 'amount'>[];
  shippingMethod: string;
  subtotal: Money;
  discount: Money;
  shipping: Money;
  shippingDiscount: Money;
  tax: Money;
  grandTotal: Money;
}

function totalsFields(): Record<string, Field<TotalsSource>> {
  return {
    currency: { type: nonNull(GraphQLString) },
    lines: {
      type: listOf(OrderLineType),
      extensions: { listSize: 50 } satisfies FieldCostExtensions,
    },
    taxes: { type: listOf(TaxType), extensions: { listSize: 50 } satisfies FieldCostExtensions },
    shippingMethod: { type: nonNull(GraphQLString) },
    subtotal: { type: nonNull(MoneyType), description: 'The sum of line subtotals.' },
    discount: { type: nonNull(MoneyType), description: 'Line and order discounts together.' },
    shipping: { type: nonNull(MoneyType) },
    shippingDiscount: { type: nonNull(MoneyType) },
    tax: { type: nonNull(MoneyType) },
    grandTotal: { type: nonNull(MoneyType) },
  };
}

const TotalsType = new GraphQLObjectType<Totals, StorefrontContext>({
  name: 'Totals',
  fields: totalsFields,
});

const CheckoutPreviewType = new GraphQLObjectType<
  { totals: Totals; paymentTermDays: number; dueOn: string },
  StorefrontContext
>({
  name: 'CheckoutPreview',
  fields: {
    totals: { type: nonNull(TotalsType) },
    paymentTermDays: { type: nonNull(GraphQLInt), description: 'Days to pay: 30 is net 30.' },
    dueOn: {
      type: nonNull(GraphQLString),
      description:
        "The day payment would be due if placed now (YYYY-MM-DD, the website's time zone).",
    },
  },
});

const LINE_PROBLEMS = [
  'product_not_available',
  'unit_not_sold',
  'invalid_quantity',
  'no_price',
] as const;

const LineProblemType = new GraphQLObjectType<LineProblem, StorefrontContext>({
  name: 'LineProblem',
  fields: {
    lineNo: { type: nonNull(GraphQLInt) },
    code: { type: nonNull(enumOf('LineProblemCode', LINE_PROBLEMS)) },
    message: { type: nonNull(GraphQLString) },
  },
});

/** A module refusal, or the API's own when no tax calculator is set up. */
export type Refusal = CheckoutRefusal | { code: 'tax_not_configured' };

const REFUSAL_CODES = [
  'not_allowed',
  'website_not_found',
  'address_not_found',
  'line_problems',
  'prices_changed',
  'idempotency_key_reused',
  'tax_not_configured',
] as const satisfies readonly Refusal['code'][];

function refusalMessage(refusal: Refusal): string {
  switch (refusal.code) {
    case 'not_allowed':
      return 'You may not place orders for your company';
    case 'website_not_found':
      return 'This storefront is not taking orders';
    case 'address_not_found':
      return `The ${refusal.role} address is not one of your company's addresses`;
    case 'line_problems':
      return 'Some lines cannot be ordered';
    case 'prices_changed':
      return 'The total changed since you last saw it; review the new total';
    case 'idempotency_key_reused':
      return 'This order key was already used for a different order';
    case 'tax_not_configured':
      return 'Checkout is not available yet: tax is not set up for this storefront';
  }
}

const CheckoutRefusalType = new GraphQLObjectType<Refusal, StorefrontContext>({
  name: 'CheckoutRefusal',
  description: 'Why a checkout cannot go on. The message is safe to show the buyer.',
  fields: {
    code: { type: nonNull(enumOf('CheckoutRefusalCode', REFUSAL_CODES)) },
    message: { type: nonNull(GraphQLString), resolve: refusalMessage },
    addressRole: {
      type: enumOf('AddressRole', ['billing', 'shipping']),
      description: 'For ADDRESS_NOT_FOUND: which address.',
      resolve: (r) => (r.code === 'address_not_found' ? r.role : null),
    },
    lines: {
      type: listOf(LineProblemType),
      description: 'For LINE_PROBLEMS: each line that cannot be ordered, and why.',
      extensions: { listSize: 50 } satisfies FieldCostExtensions,
      resolve: (r) => (r.code === 'line_problems' ? r.lines : []),
    },
    expectedGrandTotal: {
      type: MoneyType,
      description: 'For PRICES_CHANGED: the total the buyer sent.',
      resolve: (r) => (r.code === 'prices_changed' ? r.expected : null),
    },
    totals: {
      type: TotalsType,
      description: 'For PRICES_CHANGED: the totals now.',
      resolve: (r) => (r.code === 'prices_changed' ? r.totals : null),
    },
  },
});

const CheckoutPreviewResultType = new GraphQLObjectType<
  { preview: unknown; refusal: Refusal | null },
  StorefrontContext
>({
  name: 'CheckoutPreviewResult',
  description: 'Exactly one of preview and refusal is set.',
  fields: {
    preview: { type: CheckoutPreviewType },
    refusal: { type: CheckoutRefusalType },
  },
});

const OrderAddressType = new GraphQLObjectType<OrderAddress, StorefrontContext>({
  name: 'OrderAddress',
  description: 'An address as it was when the order was placed.',
  fields: {
    label: { type: nonNull(GraphQLString) },
    countryCode: { type: nonNull(GraphQLString) },
    line1: { type: nonNull(GraphQLString) },
    line2: { type: GraphQLString },
    city: { type: nonNull(GraphQLString) },
    regionCode: { type: nonNull(GraphQLString) },
    postalCode: { type: nonNull(GraphQLString) },
    gstin: { type: GraphQLString },
  },
});

function summaryFields(): Record<string, Field<OrderSummary>> {
  return {
    number: { type: nonNull(GraphQLString), description: 'For example MZ-000123.' },
    step: { type: nonNull(OrderStepType) },
    placedAt: {
      type: nonNull(GraphQLString),
      description: 'An ISO 8601 timestamp in UTC.',
      resolve: (o) => o.placedAt.toISOString(),
    },
    customerName: { type: nonNull(GraphQLString) },
    purchaseOrderNumber: { type: GraphQLString },
    grandTotal: { type: nonNull(MoneyType) },
  };
}

const OrderSummaryType = new GraphQLObjectType<OrderSummary, StorefrontContext>({
  name: 'OrderSummary',
  fields: summaryFields,
});

const OrderType = new GraphQLObjectType<Order, StorefrontContext>({
  name: 'Order',
  description: 'A placed order. It keeps its own copy of lines, prices, tax and addresses.',
  fields: () => ({
    ...summaryFields(),
    ...(totalsFields() as Record<string, Field<Order>>),
    paymentMethod: { type: nonNull(GraphQLString), description: 'TERMS: pay on invoice.' },
    paymentTermDays: { type: nonNull(GraphQLInt) },
    dueOn: { type: nonNull(GraphQLString), description: 'YYYY-MM-DD.' },
    billingAddress: { type: nonNull(OrderAddressType) },
    shippingAddress: { type: nonNull(OrderAddressType) },
  }),
});

const OrderPageType = new GraphQLObjectType<
  { nodes: OrderSummary[]; nextAfter: string | null },
  StorefrontContext
>({
  name: 'OrderPage',
  fields: {
    nodes: { type: listOf(OrderSummaryType) },
    nextAfter: {
      type: GraphQLString,
      description: 'Pass as after to read the next page; null on the last page.',
    },
  },
});

const PlaceOrderResultType = new GraphQLObjectType<
  { order: Order | null; replayed: boolean; refusal: Refusal | null },
  StorefrontContext
>({
  name: 'PlaceOrderResult',
  description: 'Exactly one of order and refusal is set.',
  fields: {
    order: { type: OrderType },
    replayed: {
      type: nonNull(GraphQLBoolean),
      description:
        'True when the idempotency key placed this order before, and it is returned again.',
    },
    refusal: { type: CheckoutRefusalType },
  },
});

function inputOf<T extends GraphQLNullableInputType>(type: T): GraphQLNonNull<T> {
  return new GraphQLNonNull(type);
}

const checkoutLineInput = new GraphQLInputObjectType({
  name: 'CheckoutLineInput',
  fields: {
    productId: { type: inputOf(GraphQLID) },
    unitCode: { type: inputOf(GraphQLString) },
    quantity: {
      type: inputOf(GraphQLString),
      description: "A decimal string at the unit's precision.",
    },
  },
});

const checkoutInputFields = {
  lines: { type: inputOf(new GraphQLList(inputOf(checkoutLineInput))) },
  billingAddressId: { type: inputOf(GraphQLID) },
  shippingAddressId: { type: inputOf(GraphQLID) },
  purchaseOrderNumber: { type: GraphQLString },
};

const CheckoutInput = new GraphQLInputObjectType({
  name: 'CheckoutInput',
  fields: checkoutInputFields,
});

const PlaceOrderInput = new GraphQLInputObjectType({
  name: 'PlaceOrderInput',
  fields: {
    ...checkoutInputFields,
    idempotencyKey: {
      type: inputOf(GraphQLID),
      description: 'A UUID the client makes once per order attempt, and sends again on a retry.',
    },
    expectedGrandTotal: {
      type: inputOf(GraphQLString),
      description: "The preview's grand total, as a decimal string; a different total refuses.",
    },
  },
});

interface CheckoutArgs {
  input: {
    lines: { productId: string; unitCode: string; quantity: string }[];
    billingAddressId: string;
    shippingAddressId: string;
    purchaseOrderNumber?: string | null;
    idempotencyKey?: string;
    expectedGrandTotal?: string;
  };
}

/** The module's request from GraphQL input, or a BAD_USER_INPUT error naming the field. */
function checkoutRequest<T extends z.ZodType>(
  schema: T,
  args: CheckoutArgs,
  ctx: StorefrontContext,
): z.output<T> {
  const { purchaseOrderNumber, ...rest } = args.input;
  const parsed = schema.safeParse({
    ...rest,
    websiteId: ctx.website.id,
    ...(purchaseOrderNumber === null || purchaseOrderNumber === undefined
      ? {}
      : { purchaseOrderNumber }),
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw badInput(
      issue ? `${['input', ...issue.path].join('.')}: ${issue.message}` : 'The input is not valid',
    );
  }
  return parsed.data;
}

const notConfigured = { code: 'tax_not_configured' } as const;

const mutation: Record<string, Field<unknown>> = {
  placeOrder: {
    type: nonNull(PlaceOrderResultType),
    description:
      'Places an order on payment terms. Everything is checked again; sending the same idempotency key again returns the same order.',
    args: { input: { type: inputOf(PlaceOrderInput) } },
    resolve: async (_root, args: CheckoutArgs, ctx) => {
      const request = checkoutRequest(placeOrderRequestSchema, args, ctx);
      if (!ctx.checkout) return { order: null, replayed: false, refusal: notConfigured };
      const result = await placeOrder(
        ctx.db,
        { buyerUserId: ctx.user.id, request, now: ctx.now },
        ctx.checkout,
      );
      return result.ok
        ? { order: result.order, replayed: result.replayed, refusal: null }
        : { order: null, replayed: false, refusal: result.refusal };
    },
  },
};

const query: Record<string, Field<unknown>> = {
  viewer: { type: nonNull(ViewerType), resolve: (_root, _args, ctx) => ctx.user },
  website: { type: nonNull(WebsiteType), resolve: (_root, _args, ctx) => ctx.website },
  categories: {
    type: listOf(CategoryType),
    description: 'Every category the buyer may see, flat; build the tree from parentId.',
    extensions: { listSize: 100 } satisfies FieldCostExtensions,
    resolve: async (_root, _args, ctx) => [...(await ctx.loaders.categories()).values()],
  },
  category: {
    type: CategoryType,
    args: { id: { type: nonNull(GraphQLID) } },
    resolve: async (_root, args: { id: string }, ctx) =>
      (await ctx.loaders.categories()).get(args.id) ?? null,
  },
  product: {
    type: ProductType,
    description: 'One product by id or by SKU (in any letter case), if the buyer may see it.',
    args: { id: { type: GraphQLID }, sku: { type: GraphQLString } },
    resolve: async (_root, args: { id?: string | null; sku?: string | null }, ctx) => {
      const byId = args.id ?? null;
      const bySku = args.sku ?? null;
      if ((byId === null) === (bySku === null)) throw badInput('Give either id or sku');
      if (byId !== null) {
        return uuid.safeParse(byId).success ? ctx.loaders.product.load(byId) : null;
      }
      const product = await findProductBySkuWithin(
        ctx.db,
        visibleProductIdsForBuyer(ctx.buyer),
        bySku ?? '',
      );
      if (product) ctx.loaders.product.prime(product.id, product);
      return product ?? null;
    },
  },
  products: {
    type: nonNull(ProductPageType),
    description: 'The products the buyer may see, by SKU, a page at a time.',
    args: {
      categoryId: { type: GraphQLID },
      includeSubcategories: { type: GraphQLBoolean, default: { value: false } },
      first: firstArg,
      after: { type: GraphQLString, description: "The previous page's nextAfter." },
    },
    resolve: async (
      _root,
      args: {
        categoryId?: string | null;
        includeSubcategories: boolean;
        first: number;
        after?: string | null;
      },
      ctx,
    ) => {
      const limit = pageSize(args.first);
      const categoryId = args.categoryId ?? null;
      // A category the buyer may not see lists nothing, rather than its visible products.
      if (categoryId !== null && !(await ctx.loaders.categories()).has(categoryId)) {
        return { nodes: [], nextAfter: null };
      }
      const page = await listProductsWithin(ctx.db, visibleProductIdsForBuyer(ctx.buyer), {
        limit,
        status: 'enabled',
        ...(categoryId === null
          ? {}
          : { categoryId, includeSubcategories: args.includeSubcategories }),
        ...(args.after === undefined || args.after === null ? {} : { after: args.after }),
      });
      for (const p of page.products) ctx.loaders.product.prime(p.id, p);
      return { nodes: page.products, nextAfter: page.nextAfter };
    },
  },
  search: {
    type: nonNull(SearchResultsType),
    description: 'Products the buyer may see, ranked: exact SKU, SKU prefix, text, close match.',
    args: {
      query: { type: nonNull(GraphQLString) },
      first: firstArg,
      offset: { type: GraphQLInt, default: { value: 0 } },
    },
    resolve: async (_root, args: { query: string; first: number; offset: number }, ctx) => {
      const page = await searchProductsForBuyer(ctx.db, ctx.buyer, {
        q: args.query,
        limit: pageSize(args.first),
        offset: args.offset,
      });
      return { nodes: page.results, nextOffset: page.nextOffset };
    },
  },
  checkoutPreview: {
    type: nonNull(CheckoutPreviewResultType),
    description:
      'The totals the buyer would pay for these lines, with their prices and tax. Saves nothing.',
    args: { input: { type: inputOf(CheckoutInput) } },
    resolve: async (_root, args: CheckoutArgs, ctx) => {
      const request = checkoutRequest(checkoutRequestSchema, args, ctx);
      if (!ctx.checkout) return { preview: null, refusal: notConfigured };
      const result = await previewCheckout(
        ctx.db,
        { buyerUserId: ctx.user.id, request, now: ctx.now },
        ctx.checkout,
      );
      return result.ok
        ? { preview: result.preview, refusal: null }
        : { preview: null, refusal: result.refusal };
    },
  },
  orders: {
    type: nonNull(OrderPageType),
    description: 'Orders the buyer may see on this website, newest first.',
    args: {
      first: firstArg,
      after: { type: GraphQLString, description: "The previous page's nextAfter." },
    },
    resolve: async (_root, args: { first: number; after?: string | null }, ctx) => {
      const limit = pageSize(args.first);
      const after = args.after ?? undefined;
      if (after !== undefined && !uuid.safeParse(after).success) {
        throw badInput("after must be a page's nextAfter");
      }
      const page = await listOrdersForBuyer(ctx.db, ctx.user.id, {
        websiteId: ctx.website.id,
        limit,
        ...(after === undefined ? {} : { after }),
      });
      return { nodes: page.orders, nextAfter: page.nextAfter };
    },
  },
  order: {
    type: OrderType,
    description: 'One order by its number, if the buyer may see it.',
    args: { number: { type: nonNull(GraphQLString) } },
    resolve: async (_root, args: { number: string }, ctx) =>
      (await findOrderForBuyer(ctx.db, ctx.user.id, {
        websiteId: ctx.website.id,
        number: args.number,
      })) ?? null,
  },
};

export const storefrontSchema = new GraphQLSchema({
  query: new GraphQLObjectType<unknown, StorefrontContext>({ name: 'Query', fields: query }),
  mutation: new GraphQLObjectType<unknown, StorefrontContext>({
    name: 'Mutation',
    fields: mutation,
  }),
});
