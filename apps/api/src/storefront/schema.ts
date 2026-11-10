import {
  findProductBySkuWithin,
  findProductsBySkusWithin,
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
import {
  isCurrencyCode,
  toDecimalString,
  type CurrencyCode,
  type Decimal,
  type Money,
} from '@muziris/money';
import {
  findOrderForBuyer,
  listOrdersForBuyer,
  ORDER_STEPS,
  PAYMENT_METHODS,
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
  type PaymentMethod,
  type Totals,
  type TotalsLine,
  type TaxLine,
  type TaxProblem,
} from '@muziris/orders';
import {
  checkPayment,
  findPaymentForOrder,
  PAYMENT_STATUSES,
  startPayment,
  type GatewayClients,
  type Payment,
  type PaymentRefusalCode,
} from '@muziris/payments';
import type { Website } from '@muziris/platform';
import { findPricesForBuyer, type PriceLookup } from '@muziris/pricing';
import { MATCHES, searchProductsForBuyer, type SearchHit } from '@muziris/search';
import {
  addShoppingListLines,
  createShoppingList,
  deleteShoppingList,
  duplicateShoppingList,
  findShoppingList,
  listShoppingLists,
  MAX_LINES_PER_LIST,
  moveShoppingListLines,
  removeShoppingListLines,
  renameShoppingList,
  updateShoppingListLine,
  type ShoppingList,
  type ShoppingListLine,
  type ShoppingListRefusal,
  type ShoppingListResult,
  type ShoppingListSummary,
} from '@muziris/shopping-lists';
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
import type { Emails } from '../emails.js';
import { FEATURE_OFF_MESSAGES, resolveFeatures, type Feature, type Features } from '../features.js';
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
  /** The configured payment gateways (ADR 0019); empty when none is. */
  payments: GatewayClients;
  /** Queues the order and payment emails (ADR 0020); none are queued without it. */
  emails: Emails | undefined;
  /** The feature toggles for this buyer's customer and website (ADR 0031), read once. */
  features: () => Promise<Features>;
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
  payments?: GatewayClients;
  emails?: Emails;
}): StorefrontContext {
  const { db, now, user, website, checkout } = input;
  const buyer: BuyerOnWebsite = { buyerUserId: user.id, websiteId: website.id };
  let categories: Promise<ReadonlyMap<string, Category>> | undefined;
  let features: Promise<Features> | undefined;
  return {
    db,
    now,
    user,
    website,
    buyer,
    checkout,
    payments: input.payments ?? {},
    emails: input.emails,
    features: () => {
      features ??= listCustomersForBuyer(db, { buyerUserId: user.id, reach: 'my_customer' }).then(
        ([customer]) =>
          resolveFeatures(db, {
            organizationId: website.organizationId,
            websiteId: website.id,
            ...(customer
              ? {
                  customerId: customer.id,
                  ...(customer.groupId === null ? {} : { customerGroupId: customer.groupId }),
                }
              : {}),
          }),
      );
      return features;
    },
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

/** Refuses a query behind a feature toggle that is off for this buyer (ADR 0031). */
async function requireFeature(ctx: StorefrontContext, feature: Feature): Promise<void> {
  if (!(await ctx.features())[feature]) {
    throw new GraphQLError(FEATURE_OFF_MESSAGES[feature], {
      extensions: { code: 'FEATURE_DISABLED' },
    });
  }
}

const FeaturesType = new GraphQLObjectType<Features, StorefrontContext>({
  name: 'Features',
  description:
    'Which storefront features are on for the signed-in buyer. The API refuses those that are off.',
  fields: {
    quickOrder: { type: nonNull(GraphQLBoolean) },
    quickOrderCsv: {
      type: nonNull(GraphQLBoolean),
      description: 'CSV upload on the quick order page; the file is read in the browser.',
    },
    shoppingLists: { type: nonNull(GraphQLBoolean) },
  },
});

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

const PaymentMethodType = enumOf(
  'PaymentMethod',
  PAYMENT_METHODS,
  'TERMS: an invoice paid later. The others are paid online through Stripe or Razorpay.',
);

const CheckoutPreviewType = new GraphQLObjectType<
  { totals: Totals; paymentMethods: PaymentMethod[]; paymentTermDays: number; dueOn: string },
  StorefrontContext
>({
  name: 'CheckoutPreview',
  fields: {
    totals: { type: nonNull(TotalsType) },
    paymentMethods: {
      type: listOf(PaymentMethodType),
      description: 'How the buyer may pay this order, in the order to offer them.',
      extensions: { listSize: 4 } satisfies FieldCostExtensions,
    },
    paymentTermDays: { type: nonNull(GraphQLInt), description: 'Days to pay: 30 is net 30.' },
    dueOn: {
      type: nonNull(GraphQLString),
      description:
        "On terms, the day payment would be due if placed now (YYYY-MM-DD, the website's time zone).",
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
  'tax_problems',
  'tax_not_configured',
  'payment_method_not_available',
] as const satisfies readonly Refusal['code'][];

const TAX_PROBLEMS = ['no_tax_code', 'no_rate', 'no_registration', 'cross_border'] as const;

const TaxProblemType = new GraphQLObjectType<TaxProblem, StorefrontContext>({
  name: 'TaxProblem',
  fields: {
    lineNo: { type: GraphQLInt, description: 'Null when the problem is the whole order.' },
    code: { type: nonNull(enumOf('TaxProblemCode', TAX_PROBLEMS)) },
    message: { type: nonNull(GraphQLString) },
  },
});

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
    case 'tax_problems':
      return 'Tax cannot be worked out for this order, so it cannot be placed yet';
    case 'tax_not_configured':
      return 'Checkout is not available yet: tax is not set up for this storefront';
    case 'payment_method_not_available':
      return 'That way of paying is not available for this order';
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
    taxProblems: {
      type: listOf(TaxProblemType),
      description: 'For TAX_PROBLEMS: what stops tax being worked out, by line or for the order.',
      extensions: { listSize: 50 } satisfies FieldCostExtensions,
      resolve: (r) => (r.code === 'tax_problems' ? r.problems : []),
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

const PaymentStatusType = enumOf(
  'PaymentStatus',
  PAYMENT_STATUSES,
  'Set only by the gateway: a signed webhook, or the API reading the gateway itself.',
);

/** An order paid online whose payment has not been started reads as pending. */
function notStarted(
  order: Order,
): Pick<Payment, 'status' | 'amountMinor' | 'currency' | 'refundedMinor'> {
  return {
    status: 'pending',
    amountMinor: order.grandTotal.minor,
    currency: order.currency,
    refundedMinor: 0n,
  };
}

function paymentMoney(minor: bigint, currency: string): Money | null {
  return isCurrencyCode(currency) ? { minor, currency } : null;
}

const OrderPaymentType = new GraphQLObjectType<
  Pick<Payment, 'status' | 'amountMinor' | 'currency' | 'refundedMinor'>,
  StorefrontContext
>({
  name: 'OrderPayment',
  fields: {
    status: { type: nonNull(PaymentStatusType) },
    amount: { type: MoneyType, resolve: (p) => paymentMoney(p.amountMinor, p.currency) },
    refunded: { type: MoneyType, resolve: (p) => paymentMoney(p.refundedMinor, p.currency) },
  },
});

const OrderType = new GraphQLObjectType<Order, StorefrontContext>({
  name: 'Order',
  description: 'A placed order. It keeps its own copy of lines, prices, tax and addresses.',
  fields: () => ({
    ...summaryFields(),
    ...(totalsFields() as Record<string, Field<Order>>),
    paymentMethod: { type: nonNull(PaymentMethodType) },
    paymentTermDays: { type: nonNull(GraphQLInt), description: 'Days to pay on terms; 0 online.' },
    dueOn: { type: GraphQLString, description: 'On terms, the day payment is due: YYYY-MM-DD.' },
    payment: {
      type: OrderPaymentType,
      description: 'The online payment and its status; null for an order on terms.',
      resolve: async (order, _args, ctx) => {
        if (order.paymentMethod === 'terms') return null;
        return (await findPaymentForOrder(ctx.db, order.id)) ?? notStarted(order);
      },
    },
    sellerTaxId: {
      type: GraphQLString,
      description: "The seller's registration the tax was charged under: a GSTIN or US permit.",
    },
    taxExemptionCertificate: {
      type: GraphQLString,
      description: "The buyer's exemption certificate that made the order tax free, if one did.",
    },
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
    paymentMethod: {
      type: PaymentMethodType,
      default: { value: 'TERMS' },
      description: "One of the preview's paymentMethods.",
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
    paymentMethod?: PaymentMethod | null;
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

// Shopping lists and quick order (ADR 0018). Lists are read and changed through the module's
// buyer-scoped functions; a line's product is read within visibility, so a product hidden since
// it was added shows as null (unavailable) rather than disappearing.

/**
 * Most SKUs one productsBySkus call may ask for. A 500-row quick order asks in pieces of this
 * size, which keeps a call with prices and units inside the query cost limit.
 */
export const MAX_QUICK_ORDER_SKUS = 100;

const ShoppingListLineType = new GraphQLObjectType<ShoppingListLine, StorefrontContext>({
  name: 'ShoppingListLine',
  fields: {
    id: { type: nonNull(GraphQLID) },
    position: { type: nonNull(GraphQLInt), description: '1, 2, 3 in the order the buyer sees.' },
    productId: { type: nonNull(GraphQLID) },
    product: {
      type: ProductType,
      description: 'Null when the buyer may no longer see or order the product.',
      resolve: async (line, _args, ctx) => {
        const product = await ctx.loaders.product.load(line.productId);
        return product?.status === 'enabled' ? product : null;
      },
    },
    unitCode: { type: nonNull(GraphQLString) },
    quantity: { type: nonNull(GraphQLString), description: 'A decimal string, such as "2.5".' },
    note: { type: GraphQLString },
    price: {
      type: PriceType,
      description: "The buyer's price now for this line's unit and quantity; null without one.",
      resolve: async (line, _args, ctx) => {
        const product = await ctx.loaders.product.load(line.productId);
        const unit = product?.units.find((u) => u.code === line.unitCode);
        if (product?.status !== 'enabled' || !unit) return null;
        const quantity = parseQuantity(line.quantity, unit);
        const lookup = await ctx.loaders.price.load({
          productId: product.id,
          unitCode: unit.code,
          quantity,
        });
        if (!lookup.found) return null;
        return {
          unitPrice: lookup.unitPrice,
          minQuantity: lookup.minQuantity,
          unitCode: unit.code,
          quantity,
        } satisfies PriceSource;
      },
    },
  },
});

function listSummaryFields(): Record<string, Field<ShoppingListSummary>> {
  return {
    id: { type: nonNull(GraphQLID) },
    name: { type: nonNull(GraphQLString) },
    lineCount: { type: nonNull(GraphQLInt) },
    isOwn: {
      type: nonNull(GraphQLBoolean),
      description: 'True when the signed-in buyer owns the list.',
      resolve: (list, _args, ctx) => list.ownerId === ctx.user.id,
    },
    updatedAt: {
      type: nonNull(GraphQLString),
      description: 'An ISO 8601 timestamp in UTC.',
      resolve: (list) => list.updatedAt.toISOString(),
    },
  };
}

const ShoppingListSummaryType = new GraphQLObjectType<ShoppingListSummary, StorefrontContext>({
  name: 'ShoppingListSummary',
  fields: listSummaryFields,
});

const ShoppingListLinePageType = new GraphQLObjectType<
  { nodes: ShoppingListLine[]; nextAfter: string | null },
  StorefrontContext
>({
  name: 'ShoppingListLinePage',
  fields: {
    nodes: { type: listOf(ShoppingListLineType) },
    nextAfter: {
      type: GraphQLString,
      description: 'Pass as after to read the next page; null on the last page.',
    },
  },
});

const ShoppingListType = new GraphQLObjectType<ShoppingList, StorefrontContext>({
  name: 'ShoppingList',
  description: 'A list of products the buyer collects to order. It stores no prices.',
  fields: () => ({
    ...(listSummaryFields() as Record<string, Field<ShoppingList>>),
    lines: {
      type: nonNull(ShoppingListLinePageType),
      description: `The lines in position order, a page at a time; a list holds at most ${String(MAX_LINES_PER_LIST)}.`,
      args: {
        first: firstArg,
        after: { type: GraphQLString, description: "The previous page's nextAfter." },
      },
      resolve: (list, args: { first: number; after?: string | null }) => {
        const limit = pageSize(args.first);
        const after = Number(args.after ?? 0);
        if (!Number.isInteger(after) || after < 0)
          throw badInput("after must be a page's nextAfter");
        const rest = list.lines.filter((l) => l.position > after);
        const nodes = rest.slice(0, limit);
        const last = nodes.at(-1);
        return {
          nodes,
          nextAfter: rest.length > limit && last ? String(last.position) : null,
        };
      },
    },
  }),
});

const ShoppingListPageType = new GraphQLObjectType<
  { nodes: ShoppingListSummary[]; nextAfter: string | null },
  StorefrontContext
>({
  name: 'ShoppingListPage',
  fields: {
    nodes: { type: listOf(ShoppingListSummaryType) },
    nextAfter: {
      type: GraphQLString,
      description: 'Pass as after to read the next page; null on the last page.',
    },
  },
});

const LIST_REFUSALS = [
  'not_allowed',
  'list_not_found',
  'line_not_found',
  'too_many_lists',
  'too_many_lines',
  'same_list',
  'line_problems',
  'feature_disabled',
] as const;

/** A module refusal, or shopping lists turned off for this buyer (ADR 0031). */
type ListRefusal = ShoppingListRefusal | { code: 'feature_disabled' };
const LISTS_OFF = { code: 'feature_disabled' } as const;

const LIST_LINE_PROBLEMS = ['product_not_available', 'unit_not_sold', 'invalid_quantity'] as const;

function listRefusalMessage(r: ListRefusal): string {
  switch (r.code) {
    case 'not_allowed':
      return 'Your buyer role does not let you change shopping lists';
    case 'list_not_found':
      return "We can't find that shopping list";
    case 'line_not_found':
      return 'That line is no longer on the list';
    case 'too_many_lists':
      return `You can keep at most ${String(r.limit)} shopping lists`;
    case 'too_many_lines':
      return `A shopping list can hold at most ${String(r.limit)} lines`;
    case 'same_list':
      return 'Choose a different list to move the lines to';
    case 'line_problems':
      return 'Some lines cannot be added; nothing was changed';
    case 'feature_disabled':
      return FEATURE_OFF_MESSAGES.shoppingLists;
  }
}

const ShoppingListLineProblemType = new GraphQLObjectType<
  { index: number; code: string; message: string },
  StorefrontContext
>({
  name: 'ShoppingListLineProblem',
  fields: {
    index: { type: nonNull(GraphQLInt), description: 'The line in the request, from 0.' },
    code: { type: nonNull(enumOf('ShoppingListLineProblemCode', LIST_LINE_PROBLEMS)) },
    message: { type: nonNull(GraphQLString) },
  },
});

const ShoppingListRefusalType = new GraphQLObjectType<ListRefusal, StorefrontContext>({
  name: 'ShoppingListRefusal',
  description: 'Why a shopping list change was refused. The message is safe to show the buyer.',
  fields: {
    code: { type: nonNull(enumOf('ShoppingListRefusalCode', LIST_REFUSALS)) },
    message: { type: nonNull(GraphQLString), resolve: listRefusalMessage },
    lines: {
      type: listOf(ShoppingListLineProblemType),
      description: 'For LINE_PROBLEMS: each line that cannot be added, and why.',
      extensions: { listSize: 50 } satisfies FieldCostExtensions,
      resolve: (r) => (r.code === 'line_problems' ? r.lines : []),
    },
  },
});

const ShoppingListResultType = new GraphQLObjectType<
  { list: ShoppingList | null; refusal: ListRefusal | null },
  StorefrontContext
>({
  name: 'ShoppingListResult',
  description: 'Exactly one of list and refusal is set.',
  fields: { list: { type: ShoppingListType }, refusal: { type: ShoppingListRefusalType } },
});

const DeleteShoppingListResultType = new GraphQLObjectType<
  { deleted: boolean; refusal: ListRefusal | null },
  StorefrontContext
>({
  name: 'DeleteShoppingListResult',
  fields: {
    deleted: { type: nonNull(GraphQLBoolean) },
    refusal: { type: ShoppingListRefusalType },
  },
});

const ProductsBySkusResultType = new GraphQLObjectType<
  { products: Product[]; missingSkus: string[] },
  StorefrontContext
>({
  name: 'ProductsBySkusResult',
  fields: {
    products: {
      type: listOf(ProductType),
      description: 'The products found, in the order their SKUs were asked for.',
      extensions: { listSize: MAX_QUICK_ORDER_SKUS } satisfies FieldCostExtensions,
    },
    missingSkus: {
      type: listOf(GraphQLString),
      description: 'SKUs that are unknown, or that the buyer may not see or order, as sent.',
      extensions: { listSize: MAX_QUICK_ORDER_SKUS } satisfies FieldCostExtensions,
    },
  },
});

function listResult(result: ShoppingListResult) {
  return result.ok ? { list: result.list, refusal: null } : { list: null, refusal: result.refusal };
}

const shoppingListLineInput = new GraphQLInputObjectType({
  name: 'ShoppingListLineInput',
  fields: {
    productId: { type: inputOf(GraphQLID) },
    unitCode: { type: inputOf(GraphQLString) },
    quantity: {
      type: inputOf(GraphQLString),
      description: "A decimal string at the unit's precision, above zero.",
    },
    note: { type: GraphQLString },
  },
});

interface LineInput {
  productId: string;
  unitCode: string;
  quantity: string;
  note?: string | null;
}

function lineInputs(lines: readonly LineInput[]) {
  if (lines.length === 0 || lines.length > MAX_LINES_PER_LIST) {
    throw badInput(`Send from 1 to ${String(MAX_LINES_PER_LIST)} lines`);
  }
  return lines.map((l) => {
    if (!uuid.safeParse(l.productId).success) throw badInput('productId must be a product id');
    return {
      productId: l.productId,
      unitCode: l.unitCode,
      quantity: l.quantity,
      ...(l.note === undefined ? {} : { note: l.note }),
    };
  });
}

function listName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw badInput('A list name has 1 to 100 characters');
  }
  return trimmed;
}

function idList(ids: readonly string[], what: string): string[] {
  if (
    ids.length === 0 ||
    ids.length > MAX_LINES_PER_LIST ||
    !ids.every((i) => uuid.safeParse(i).success)
  ) {
    throw badInput(`${what} must be 1 to ${String(MAX_LINES_PER_LIST)} ids`);
  }
  return [...ids];
}

const listIdArg = { listId: { type: nonNull(GraphQLID) } };

const listMutations: Record<string, Field<unknown>> = {
  createShoppingList: {
    type: nonNull(ShoppingListResultType),
    args: { name: { type: nonNull(GraphQLString) } },
    resolve: async (_root, args: { name: string }, ctx) =>
      listResult(
        await createShoppingList(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          name: listName(args.name),
        }),
      ),
  },
  renameShoppingList: {
    type: nonNull(ShoppingListResultType),
    args: { ...listIdArg, name: { type: nonNull(GraphQLString) } },
    resolve: async (_root, args: { listId: string; name: string }, ctx) =>
      listResult(
        await renameShoppingList(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          listId: args.listId,
          name: listName(args.name),
        }),
      ),
  },
  duplicateShoppingList: {
    type: nonNull(ShoppingListResultType),
    description: 'A copy owned by the buyer, with the lines whose products they may still see.',
    args: { ...listIdArg, name: { type: nonNull(GraphQLString) } },
    resolve: async (_root, args: { listId: string; name: string }, ctx) =>
      listResult(
        await duplicateShoppingList(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          listId: args.listId,
          name: listName(args.name),
        }),
      ),
  },
  deleteShoppingList: {
    type: nonNull(DeleteShoppingListResultType),
    args: listIdArg,
    resolve: async (_root, args: { listId: string }, ctx) => {
      const result = await deleteShoppingList(ctx.db, ctx.user.id, {
        websiteId: ctx.website.id,
        listId: args.listId,
      });
      return result.ok
        ? { deleted: true, refusal: null }
        : { deleted: false, refusal: result.refusal };
    },
  },
  addShoppingListLines: {
    type: nonNull(ShoppingListResultType),
    description:
      'Adds lines; the same product and unit adds to the line already there. Nothing is added when any line has a problem.',
    args: {
      ...listIdArg,
      lines: { type: inputOf(new GraphQLList(inputOf(shoppingListLineInput))) },
    },
    resolve: async (_root, args: { listId: string; lines: LineInput[] }, ctx) =>
      listResult(
        await addShoppingListLines(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          listId: args.listId,
          lines: lineInputs(args.lines),
        }),
      ),
  },
  updateShoppingListLine: {
    type: nonNull(ShoppingListResultType),
    description: "Changes a line's quantity, unit or note; leave out what stays.",
    args: {
      ...listIdArg,
      lineId: { type: nonNull(GraphQLID) },
      quantity: { type: GraphQLString },
      unitCode: { type: GraphQLString },
      note: { type: GraphQLString, description: 'An empty string clears the note.' },
    },
    resolve: async (
      _root,
      args: {
        listId: string;
        lineId: string;
        quantity?: string | null;
        unitCode?: string | null;
        note?: string | null;
      },
      ctx,
    ) =>
      listResult(
        await updateShoppingListLine(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          listId: args.listId,
          lineId: args.lineId,
          ...(args.quantity ? { quantity: args.quantity } : {}),
          ...(args.unitCode ? { unitCode: args.unitCode } : {}),
          ...(args.note === undefined ? {} : { note: args.note }),
        }),
      ),
  },
  removeShoppingListLines: {
    type: nonNull(ShoppingListResultType),
    args: { ...listIdArg, lineIds: { type: inputOf(new GraphQLList(inputOf(GraphQLID))) } },
    resolve: async (_root, args: { listId: string; lineIds: string[] }, ctx) =>
      listResult(
        await removeShoppingListLines(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          listId: args.listId,
          lineIds: idList(args.lineIds, 'lineIds'),
        }),
      ),
  },
  moveShoppingListLines: {
    type: nonNull(ShoppingListResultType),
    description: 'Moves lines to another list, merging into lines there. Returns the target list.',
    args: {
      fromListId: { type: nonNull(GraphQLID) },
      toListId: { type: nonNull(GraphQLID) },
      lineIds: { type: inputOf(new GraphQLList(inputOf(GraphQLID))) },
    },
    resolve: async (
      _root,
      args: { fromListId: string; toListId: string; lineIds: string[] },
      ctx,
    ) =>
      listResult(
        await moveShoppingListLines(ctx.db, ctx.user.id, {
          websiteId: ctx.website.id,
          fromListId: args.fromListId,
          toListId: args.toListId,
          lineIds: idList(args.lineIds, 'lineIds'),
        }),
      ),
  },
};

/** Every list mutation answers a refusal, changing nothing, while lists are off (ADR 0031). */
const shoppingListMutations: Record<string, Field<unknown>> = Object.fromEntries(
  Object.entries(listMutations).map(([name, field]) => [
    name,
    {
      ...field,
      resolve: async (root, args, ctx, info) => {
        if (!(await ctx.features()).shoppingLists) {
          return name === 'deleteShoppingList'
            ? { deleted: false, refusal: LISTS_OFF }
            : { list: null, refusal: LISTS_OFF };
        }
        if (!field.resolve) throw new Error(`${name} has no resolver`);
        return field.resolve(root, args, ctx, info);
      },
    } satisfies Field<unknown>,
  ]),
);

const shoppingListQueries: Record<string, Field<unknown>> = {
  features: {
    type: nonNull(FeaturesType),
    description: 'Which storefront features are on for the signed-in buyer.',
    resolve: (_root, _args, ctx) => ctx.features(),
  },
  shoppingLists: {
    type: nonNull(ShoppingListPageType),
    description: 'Shopping lists the buyer may see on this website, most recently changed first.',
    args: {
      first: firstArg,
      after: { type: GraphQLString, description: "The previous page's nextAfter." },
    },
    resolve: async (_root, args: { first: number; after?: string | null }, ctx) => {
      await requireFeature(ctx, 'shoppingLists');
      const page = await listShoppingLists(ctx.db, ctx.user.id, {
        websiteId: ctx.website.id,
        limit: pageSize(args.first),
        ...(args.after ? { after: args.after } : {}),
      });
      return { nodes: page.lists, nextAfter: page.nextAfter };
    },
  },
  shoppingList: {
    type: ShoppingListType,
    description: 'One shopping list, if the buyer may see it.',
    args: { id: { type: nonNull(GraphQLID) } },
    resolve: async (_root, args: { id: string }, ctx) => {
      await requireFeature(ctx, 'shoppingLists');
      return (await findShoppingList(ctx.db, ctx.user.id, ctx.website.id, args.id)) ?? null;
    },
  },
  productsBySkus: {
    type: nonNull(ProductsBySkusResultType),
    description: `Products the buyer may order, by SKU in any letter case, for quick order. At most ${String(MAX_QUICK_ORDER_SKUS)} SKUs.`,
    args: { skus: { type: inputOf(new GraphQLList(inputOf(GraphQLString))) } },
    resolve: async (_root, args: { skus: string[] }, ctx) => {
      await requireFeature(ctx, 'quickOrder');
      if (args.skus.length > MAX_QUICK_ORDER_SKUS) {
        throw badInput(`Ask for at most ${String(MAX_QUICK_ORDER_SKUS)} SKUs`);
      }
      const found = (
        await findProductsBySkusWithin(ctx.db, visibleProductIdsForBuyer(ctx.buyer), args.skus)
      ).filter((p) => p.status === 'enabled');
      const bySku = new Map(found.map((p) => [p.sku.toLowerCase(), p]));
      const products: Product[] = [];
      const missingSkus: string[] = [];
      const seen = new Set<string>();
      for (const sku of args.skus) {
        const key = sku.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const product = bySku.get(key);
        if (product) {
          ctx.loaders.product.prime(product.id, product);
          products.push(product);
        } else {
          missingSkus.push(sku);
        }
      }
      return { products, missingSkus };
    },
  },
};

const notConfigured = { code: 'tax_not_configured' } as const;

// Paying online (ADR 0019). The browser gets only what the gateway's own form needs; card and
// bank details go from the buyer straight to the gateway.

const PAYMENT_REFUSALS = [
  'order_not_found',
  'not_paid_online',
  'already_paid',
  'payment_closed',
  'gateway_not_configured',
  'gateway_unavailable',
] as const satisfies readonly PaymentRefusalCode[];

const PAYMENT_REFUSAL_MESSAGES: Record<PaymentRefusalCode, string> = {
  order_not_found: 'We can’t find that order',
  not_paid_online: 'This order is paid on your payment terms, not online',
  already_paid: 'This order is already paid',
  payment_closed: 'This payment was cancelled; contact us to pay this order',
  gateway_not_configured: 'Paying online is not available on this storefront',
  gateway_unavailable: 'The payment service did not answer. Try again in a minute.',
};

const PaymentRefusalType = new GraphQLObjectType<{ code: PaymentRefusalCode }, StorefrontContext>({
  name: 'PaymentRefusal',
  description: 'Why paying cannot go on. The message is safe to show the buyer.',
  fields: {
    code: { type: nonNull(enumOf('PaymentRefusalCode', PAYMENT_REFUSALS)) },
    message: { type: nonNull(GraphQLString), resolve: (r) => PAYMENT_REFUSAL_MESSAGES[r.code] },
  },
});

const StripePaymentStartType = new GraphQLObjectType<
  { publishableKey: string; clientSecret: string },
  StorefrontContext
>({
  name: 'StripePaymentStart',
  description: "What Stripe's Payment Element needs, from js.stripe.com.",
  fields: {
    publishableKey: { type: nonNull(GraphQLString) },
    clientSecret: {
      type: nonNull(GraphQLString),
      description: 'Lets the browser complete this one payment. Do not store or log it.',
    },
  },
});

const RazorpayPaymentStartType = new GraphQLObjectType<
  { keyId: string; razorpayOrderId: string; amountMinor: bigint; currency: string },
  StorefrontContext
>({
  name: 'RazorpayPaymentStart',
  description: 'What Razorpay Checkout needs, from checkout.razorpay.com.',
  fields: {
    keyId: { type: nonNull(GraphQLString) },
    orderId: { type: nonNull(GraphQLString), resolve: (r) => r.razorpayOrderId },
    amount: { type: MoneyType, resolve: (r) => paymentMoney(r.amountMinor, r.currency) },
  },
});

const StartPaymentResultType = new GraphQLObjectType<
  {
    stripe: { publishableKey: string; clientSecret: string } | null;
    razorpay: {
      keyId: string;
      razorpayOrderId: string;
      amountMinor: bigint;
      currency: string;
    } | null;
    refusal: { code: PaymentRefusalCode } | null;
  },
  StorefrontContext
>({
  name: 'StartPaymentResult',
  description: 'Exactly one of stripe, razorpay and refusal is set.',
  fields: {
    stripe: { type: StripePaymentStartType },
    razorpay: { type: RazorpayPaymentStartType },
    refusal: { type: PaymentRefusalType },
  },
});

const CheckPaymentResultType = new GraphQLObjectType<
  {
    payment: Pick<Payment, 'status' | 'amountMinor' | 'currency' | 'refundedMinor'> | null;
    refusal: { code: PaymentRefusalCode } | null;
  },
  StorefrontContext
>({
  name: 'CheckPaymentResult',
  description: 'Exactly one of payment and refusal is set.',
  fields: {
    payment: { type: OrderPaymentType },
    refusal: { type: PaymentRefusalType },
  },
});

const orderNumberArg = { orderNumber: { type: nonNull(GraphQLString) } };

const paymentMutations: Record<string, Field<unknown>> = {
  startPayment: {
    type: nonNull(StartPaymentResultType),
    description:
      'Starts paying an order placed with an online method, or starts again after a failure.',
    args: orderNumberArg,
    resolve: async (_root, args: { orderNumber: string }, ctx) => {
      const result = await startPayment(ctx.db, ctx.payments, {
        buyerUserId: ctx.user.id,
        websiteId: ctx.website.id,
        orderNumber: args.orderNumber,
        now: ctx.now,
      });
      if (!result.ok) return { stripe: null, razorpay: null, refusal: { code: result.refusal } };
      const { start } = result;
      return start.gateway === 'stripe'
        ? { stripe: start, razorpay: null, refusal: null }
        : { stripe: null, razorpay: start, refusal: null };
    },
  },
  checkPayment: {
    type: nonNull(CheckPaymentResultType),
    description:
      "The order's payment now. A pending payment is read from the gateway, server to server.",
    args: orderNumberArg,
    resolve: async (_root, args: { orderNumber: string }, ctx) => {
      const order = await findOrderForBuyer(ctx.db, ctx.user.id, {
        websiteId: ctx.website.id,
        number: args.orderNumber,
      });
      const hooks = ctx.emails && order ? await ctx.emails.payment(order, ctx.now) : {};
      const result = await checkPayment(
        ctx.db,
        ctx.payments,
        {
          buyerUserId: ctx.user.id,
          websiteId: ctx.website.id,
          orderNumber: args.orderNumber,
          now: ctx.now,
        },
        hooks,
      );
      if (!result.ok) return { payment: null, refusal: { code: result.refusal } };
      return {
        payment: result.payment ?? (order ? notStarted(order) : null),
        refusal: null,
      };
    },
  },
};

const mutation: Record<string, Field<unknown>> = {
  placeOrder: {
    type: nonNull(PlaceOrderResultType),
    description:
      'Places an order, on payment terms or to pay online next. Everything is checked again; sending the same idempotency key again returns the same order.',
    args: { input: { type: inputOf(PlaceOrderInput) } },
    resolve: async (_root, args: CheckoutArgs, ctx) => {
      const request = checkoutRequest(placeOrderRequestSchema, args, ctx);
      if (!ctx.checkout) return { order: null, replayed: false, refusal: notConfigured };
      // The order emails are queued in the order's transaction (ADR 0020).
      const inTransaction = await ctx.emails?.orderPlaced(ctx.user, ctx.website, ctx.now);
      const result = await placeOrder(
        ctx.db,
        {
          buyerUserId: ctx.user.id,
          request,
          now: ctx.now,
          ...(inTransaction ? { inTransaction } : {}),
        },
        ctx.checkout,
      );
      return result.ok
        ? { order: result.order, replayed: result.replayed, refusal: null }
        : { order: null, replayed: false, refusal: result.refusal };
    },
  },
  ...shoppingListMutations,
  ...paymentMutations,
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
  ...shoppingListQueries,
};

export const storefrontSchema = new GraphQLSchema({
  query: new GraphQLObjectType<unknown, StorefrontContext>({ name: 'Query', fields: query }),
  mutation: new GraphQLObjectType<unknown, StorefrontContext>({
    name: 'Mutation',
    fields: mutation,
  }),
});
