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
import { listCustomersForBuyer } from '@muziris/customers';
import type { Database } from '@muziris/db';
import type { AuthenticatedUser } from '@muziris/identity';
import { toDecimalString, type CurrencyCode, type Decimal } from '@muziris/money';
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
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfig,
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
}): StorefrontContext {
  const { db, now, user, website } = input;
  const buyer: BuyerOnWebsite = { buyerUserId: user.id, websiteId: website.id };
  let categories: Promise<ReadonlyMap<string, Category>> | undefined;
  return {
    db,
    now,
    user,
    website,
    buyer,
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

const CustomerType = new GraphQLObjectType<{ id: string; name: string }, StorefrontContext>({
  name: 'Customer',
  description: 'The company the buyer user buys for.',
  fields: {
    id: { type: nonNull(GraphQLID) },
    name: { type: nonNull(GraphQLString) },
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
};

export const storefrontSchema = new GraphQLSchema({
  query: new GraphQLObjectType<unknown, StorefrontContext>({ name: 'Query', fields: query }),
});
