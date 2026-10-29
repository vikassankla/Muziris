// Known-answer tables for the fallback order and category inheritance of ADR 0012. The unit tests
// run them through `resolveProductVisibility` and `resolveCategoryVisibility`; the integration
// tests run the same tables through the set-based build and the buyer-scoped selects on
// PostgreSQL. Each case asks about one product or category for one customer, who is in a
// customer group unless the case says otherwise, on one website.

/** The category tree every case uses: Power transmission > Bearings > Ball bearings, and Safety. */
export const CATEGORY_PARENTS = {
  power: null,
  bearings: 'power',
  ball: 'bearings',
  safety: null,
} as const;

export type CategoryCode = keyof typeof CATEGORY_PARENTS;

export const CATEGORY_CODES = Object.keys(CATEGORY_PARENTS) as CategoryCode[];

/**
 * Who a rule is for. The `other_` targets are another customer, another customer group and
 * another website: their rules must never reach the case's customer.
 */
export type CaseTarget =
  'customer' | 'customer_group' | 'website' | 'other_customer' | 'other_group' | 'other_website';

export interface RuleSpec {
  target: CaseTarget;
  /** The case's product, or a category. */
  subject: 'product' | CategoryCode;
  visibility: 'visible' | 'hidden';
}

/**
 * What decided: `default`, `disabled`, or `<level>:<subject>` for the deciding rule, for
 * example `customer_group:bearings`.
 */
export type DecidedBy =
  | 'default'
  | 'disabled'
  | `${'customer' | 'customer_group' | 'website'}:${'product' | CategoryCode}`;

export interface ProductCase {
  title: string;
  /** The product's category; null for none. */
  category: CategoryCode | null;
  /** False for a disabled product. */
  enabled: boolean;
  /** False for a customer without a customer group. */
  inGroup: boolean;
  rules: readonly RuleSpec[];
  expected: { visible: boolean; decidedBy: DecidedBy };
}

export interface CategoryCase {
  title: string;
  category: CategoryCode;
  rules: readonly RuleSpec[];
  expected: { visible: boolean; decidedBy: DecidedBy };
}

const rule = (
  target: CaseTarget,
  subject: RuleSpec['subject'],
  visibility: RuleSpec['visibility'],
): RuleSpec => ({ target, subject, visibility });

const product = (
  title: string,
  rules: readonly RuleSpec[],
  expected: ProductCase['expected'],
  extra: Partial<Omit<ProductCase, 'title' | 'rules' | 'expected'>> = {},
): ProductCase => ({
  title,
  category: 'ball',
  enabled: true,
  inGroup: true,
  rules,
  expected,
  ...extra,
});

const visible = (decidedBy: DecidedBy) => ({ visible: true, decidedBy });
const hidden = (decidedBy: DecidedBy) => ({ visible: false, decidedBy });

/** Which level decides, in the order customer, customer group, website. */
export const FALLBACK_CASES: readonly ProductCase[] = [
  product('no rules: an enabled product is visible', [], visible('default')),
  product(
    'the website hides the product',
    [rule('website', 'product', 'hidden')],
    hidden('website:product'),
  ),
  product(
    'the website hides a top category, the group shows Bearings',
    [rule('website', 'power', 'hidden'), rule('customer_group', 'bearings', 'visible')],
    visible('customer_group:bearings'),
  ),
  product(
    'a more specific target beats a more specific subject',
    [rule('website', 'product', 'hidden'), rule('customer_group', 'bearings', 'visible')],
    visible('customer_group:bearings'),
  ),
  product(
    'the customer shows a top category its group hides the product in',
    [rule('customer_group', 'product', 'hidden'), rule('customer', 'power', 'visible')],
    visible('customer:power'),
  ),
  product(
    'the customer level wins over group and website',
    [
      rule('customer', 'product', 'hidden'),
      rule('customer_group', 'product', 'visible'),
      rule('website', 'product', 'visible'),
    ],
    hidden('customer:product'),
  ),
  product(
    'the group decides when the customer has no rule',
    [rule('customer_group', 'product', 'hidden'), rule('website', 'product', 'visible')],
    hidden('customer_group:product'),
  ),
  product(
    "another customer's rule does not apply",
    [rule('other_customer', 'product', 'hidden')],
    visible('default'),
  ),
  product(
    "another group's rule does not apply",
    [rule('other_group', 'product', 'hidden')],
    visible('default'),
  ),
  product(
    "another website's rule does not apply",
    [rule('other_website', 'product', 'hidden')],
    visible('default'),
  ),
  product(
    'a customer without a group skips the group level',
    [rule('customer_group', 'product', 'hidden'), rule('website', 'power', 'visible')],
    visible('website:power'),
    { inGroup: false },
  ),
  product(
    'a disabled product is never visible, whatever the rules say',
    [rule('customer', 'product', 'visible'), rule('website', 'product', 'visible')],
    hidden('disabled'),
    { enabled: false },
  ),
  product('a disabled product without rules is not visible', [], hidden('disabled'), {
    enabled: false,
  }),
  product(
    'a product without a category ignores category rules',
    [rule('website', 'power', 'hidden'), rule('customer', 'ball', 'hidden')],
    visible('default'),
    { category: null },
  ),
  product(
    'a product without a category follows its own rules',
    [rule('website', 'product', 'hidden')],
    hidden('website:product'),
    { category: null },
  ),
];

/** Within a level: the product's own rule, then its category, then the categories above it. */
export const INHERITANCE_CASES: readonly ProductCase[] = [
  product(
    'a rule two categories up applies',
    [rule('website', 'power', 'hidden')],
    hidden('website:power'),
  ),
  product(
    'the nearer category wins',
    [rule('website', 'power', 'hidden'), rule('website', 'bearings', 'visible')],
    visible('website:bearings'),
  ),
  product(
    "the product's own category is nearest",
    [
      rule('website', 'power', 'hidden'),
      rule('website', 'bearings', 'visible'),
      rule('website', 'ball', 'hidden'),
    ],
    hidden('website:ball'),
  ),
  product(
    'the product rule beats its own category at the same level',
    [rule('website', 'ball', 'hidden'), rule('website', 'product', 'visible')],
    visible('website:product'),
  ),
  product(
    'a level with a far category rule beats a later level with a near one',
    [rule('customer_group', 'power', 'hidden'), rule('website', 'ball', 'visible')],
    hidden('customer_group:power'),
  ),
  product(
    "a subcategory's rule does not reach a product in its parent",
    [rule('website', 'ball', 'hidden')],
    visible('default'),
    { category: 'bearings' },
  ),
  product(
    'a rule on another branch of the tree does not apply',
    [rule('website', 'power', 'hidden')],
    visible('default'),
    { category: 'safety' },
  ),
  product(
    'the customer reopens one category under a hidden tree',
    [rule('website', 'power', 'hidden'), rule('customer', 'ball', 'visible')],
    visible('customer:ball'),
  ),
];

const category = (
  code: CategoryCode,
  title: string,
  rules: readonly RuleSpec[],
  expected: CategoryCase['expected'],
): CategoryCase => ({ title, category: code, rules, expected });

/** Categories are decided the same way, starting with the category itself. */
export const CATEGORY_CASES: readonly CategoryCase[] = [
  category('ball', 'no rules: a category is visible', [], visible('default')),
  category(
    'ball',
    'a hidden top category hides the categories below it',
    [rule('website', 'power', 'hidden')],
    hidden('website:power'),
  ),
  category(
    'safety',
    'a hidden top category leaves other trees alone',
    [rule('website', 'power', 'hidden')],
    visible('default'),
  ),
  category(
    'bearings',
    'the group shows a category the website hides above it',
    [rule('website', 'power', 'hidden'), rule('customer_group', 'bearings', 'visible')],
    visible('customer_group:bearings'),
  ),
  category(
    'power',
    'showing a subcategory does not show its parent',
    [rule('website', 'power', 'hidden'), rule('customer_group', 'bearings', 'visible')],
    hidden('website:power'),
  ),
  category(
    'ball',
    'product rules do not change categories',
    [rule('website', 'product', 'hidden')],
    visible('default'),
  ),
  category(
    'ball',
    'the customer level wins',
    [rule('customer', 'ball', 'hidden'), rule('website', 'ball', 'visible')],
    hidden('customer:ball'),
  ),
  category(
    'ball',
    "another customer's rule does not apply",
    [rule('other_customer', 'power', 'hidden')],
    visible('default'),
  ),
];

/** The case's category and every category above it, nearest first. */
export function categoryPathOf(code: CategoryCode | null): CategoryCode[] {
  const path: CategoryCode[] = [];
  for (let at: CategoryCode | null = code; at !== null; at = CATEGORY_PARENTS[at]) path.push(at);
  return path;
}
