// Known-answer tables for the fallback chain of ADR 0011. The unit tests run them through
// `resolvePrice`; the integration tests run the same tables through the set-based build and the
// combined price lookup on PostgreSQL. Each case prices one product for one customer, who is in a
// customer group, on one website.

export type UnitCode = 'each' | 'kg';

/** Product units in the tables: `each` takes whole numbers, `kg` three decimals. */
export const UNIT_PRECISION: Record<UnitCode, number> = { each: 0, kg: 3 };

export interface ListSpec {
  name: string;
  target: 'customer' | 'customer_group' | 'website';
  priority: number;
  activeFrom?: string;
  activeUntil?: string;
  /** Tiers for the product: product unit, minimum quantity, amount. */
  tiers: readonly (readonly [UnitCode, string, string])[];
}

export interface PriceCase {
  title: string;
  /** The website's currency; every price list is in it. */
  currency: 'INR' | 'USD' | 'JPY';
  lists: readonly ListSpec[];
  unit: UnitCode;
  quantity: string;
  now: string;
  /** The unit price, the price list it comes from, the tier and the rounded line amount. */
  expected: { amount: string; from: string; minQuantity: string; line: string } | null;
}

const NOW = '2026-11-04T09:00:00.000Z';

const contract = (tiers: ListSpec['tiers'], extra: Partial<ListSpec> = {}): ListSpec => ({
  name: 'Customer contract',
  target: 'customer',
  priority: 1,
  tiers,
  ...extra,
});
const groupList = (tiers: ListSpec['tiers'], extra: Partial<ListSpec> = {}): ListSpec => ({
  name: 'Distributor net',
  target: 'customer_group',
  priority: 1,
  tiers,
  ...extra,
});
const websiteList = (tiers: ListSpec['tiers'], extra: Partial<ListSpec> = {}): ListSpec => ({
  name: 'List price',
  target: 'website',
  priority: 1,
  tiers,
  ...extra,
});

const each = (quantity: string, lists: readonly ListSpec[]) => ({
  currency: 'INR' as const,
  unit: 'each' as const,
  quantity,
  now: NOW,
  lists,
});

export const FALLBACK_CASES: readonly PriceCase[] = [
  {
    title: 'the customer price list wins over the group and the website',
    ...each('1', [
      contract([['each', '1', '100.00']]),
      groupList([['each', '1', '90.00']]),
      websiteList([['each', '1', '80.00']]),
    ]),
    expected: { amount: '100.00', from: 'Customer contract', minQuantity: '1', line: '100.00' },
  },
  {
    title: 'a customer price list without the product falls through to the group',
    ...each('1', [
      contract([['kg', '1', '1.00']]),
      groupList([['each', '1', '90.00']]),
      websiteList([['each', '1', '80.00']]),
    ]),
    expected: { amount: '90.00', from: 'Distributor net', minQuantity: '1', line: '90.00' },
  },
  {
    title: 'the website price list prices a customer with nothing of its own',
    ...each('3', [websiteList([['each', '1', '80.00']])]),
    expected: { amount: '80.00', from: 'List price', minQuantity: '1', line: '240.00' },
  },
  {
    title: 'no price list prices the product',
    ...each('1', [contract([['kg', '1', '1.00']]), websiteList([])]),
    expected: null,
  },
  {
    title: 'the group wins over a cheaper website price: first found, not lowest',
    ...each('1', [groupList([['each', '1', '90.00']]), websiteList([['each', '1', '50.00']])]),
    expected: { amount: '90.00', from: 'Distributor net', minQuantity: '1', line: '90.00' },
  },
  {
    title: 'priority 1 wins over priority 2 within the customer',
    ...each('1', [
      contract([['each', '1', '70.00']], { name: 'Contract A', priority: 1 }),
      contract([['each', '1', '60.00']], { name: 'Contract B', priority: 2 }),
    ]),
    expected: { amount: '70.00', from: 'Contract A', minQuantity: '1', line: '70.00' },
  },
  {
    title: 'priority 2 prices what priority 1 lacks',
    ...each('1', [
      contract([['kg', '1', '1.00']], { name: 'Contract A', priority: 1 }),
      contract([['each', '1', '60.00']], { name: 'Contract B', priority: 2 }),
      websiteList([['each', '1', '80.00']]),
    ]),
    expected: { amount: '60.00', from: 'Contract B', minQuantity: '1', line: '60.00' },
  },
  {
    title: 'the order of priorities, not of creation, decides',
    ...each('1', [
      websiteList([['each', '1', '80.00']], { name: 'Website second', priority: 7 }),
      websiteList([['each', '1', '75.00']], { name: 'Website first', priority: 3 }),
    ]),
    expected: { amount: '75.00', from: 'Website first', minQuantity: '1', line: '75.00' },
  },
];

const tiered = [
  websiteList([
    ['each', '1', '10.00'],
    ['each', '10', '9.00'],
    ['each', '100', '8.00'],
  ]),
];

/** A contract with only a volume tier, over a website list with its own tiers. */
const volumeDeal = [
  contract([['each', '100', '7.00']]),
  websiteList([
    ['each', '1', '10.00'],
    ['each', '1000', '6.00'],
  ]),
];

const byWeight = [
  websiteList([
    ['kg', '0.5', '200.00'],
    ['kg', '2.5', '180.00'],
  ]),
];

export const TIER_CASES: readonly PriceCase[] = [
  {
    title: 'quantity 1 takes the 1+ tier',
    ...each('1', tiered),
    expected: { amount: '10.00', from: 'List price', minQuantity: '1', line: '10.00' },
  },
  {
    title: 'quantity 9 stays on the 1+ tier',
    ...each('9', tiered),
    expected: { amount: '10.00', from: 'List price', minQuantity: '1', line: '90.00' },
  },
  {
    title: 'quantity 10 reaches the 10+ tier',
    ...each('10', tiered),
    expected: { amount: '9.00', from: 'List price', minQuantity: '10', line: '90.00' },
  },
  {
    title: 'quantity 99 stays on the 10+ tier',
    ...each('99', tiered),
    expected: { amount: '9.00', from: 'List price', minQuantity: '10', line: '891.00' },
  },
  {
    title: 'quantity 100 reaches the 100+ tier',
    ...each('100', tiered),
    expected: { amount: '8.00', from: 'List price', minQuantity: '100', line: '800.00' },
  },
  {
    title: 'quantity 5000 keeps the highest tier',
    ...each('5000', tiered),
    expected: { amount: '8.00', from: 'List price', minQuantity: '100', line: '40000.00' },
  },
  {
    title: 'below the contract volume tier, the website prices',
    ...each('99', volumeDeal),
    expected: { amount: '10.00', from: 'List price', minQuantity: '1', line: '990.00' },
  },
  {
    title: 'at the contract volume tier, the contract prices',
    ...each('100', volumeDeal),
    expected: { amount: '7.00', from: 'Customer contract', minQuantity: '100', line: '700.00' },
  },
  {
    title: 'above a cheaper website tier, the contract still prices: first found wins',
    ...each('1000', volumeDeal),
    expected: { amount: '7.00', from: 'Customer contract', minQuantity: '100', line: '7000.00' },
  },
  {
    title: 'a decimal quantity just below the lowest tier has no price',
    currency: 'INR',
    unit: 'kg',
    quantity: '0.499',
    now: NOW,
    lists: byWeight,
    expected: null,
  },
  {
    title: 'a decimal quantity at the lowest tier',
    currency: 'INR',
    unit: 'kg',
    quantity: '0.5',
    now: NOW,
    lists: byWeight,
    expected: { amount: '200.00', from: 'List price', minQuantity: '0.5', line: '100.00' },
  },
  {
    title: 'a decimal quantity just below the next tier',
    currency: 'INR',
    unit: 'kg',
    quantity: '2.499',
    now: NOW,
    lists: byWeight,
    expected: { amount: '200.00', from: 'List price', minQuantity: '0.5', line: '499.80' },
  },
  {
    title: 'a decimal quantity at the next tier',
    currency: 'INR',
    unit: 'kg',
    quantity: '2.5',
    now: NOW,
    lists: byWeight,
    expected: { amount: '180.00', from: 'List price', minQuantity: '2.5', line: '450.00' },
  },
  {
    title: 'tiers in one product unit do not price another',
    ...each('5', byWeight),
    expected: null,
  },
];

export const CURRENCY_CASES: readonly PriceCase[] = [
  {
    title: 'INR in paise',
    ...each('3', [websiteList([['each', '1', '1250.50']])]),
    expected: { amount: '1250.50', from: 'List price', minQuantity: '1', line: '3751.50' },
  },
  {
    title: 'USD in cents, as on the PriceListDetail board',
    currency: 'USD',
    unit: 'each',
    quantity: '120',
    now: NOW,
    lists: [
      groupList(
        [
          ['each', '1', '5.38'],
          ['each', '100', '4.86'],
          ['each', '1000', '4.41'],
        ],
        { name: 'US distributor net 2026' },
      ),
      websiteList([['each', '1', '6.40']], { name: 'US list price' }),
    ],
    expected: {
      amount: '4.86',
      from: 'US distributor net 2026',
      minQuantity: '100',
      line: '583.20',
    },
  },
  {
    title: 'JPY has no minor unit',
    currency: 'JPY',
    unit: 'each',
    quantity: '4',
    now: NOW,
    lists: [websiteList([['each', '1', '1500']])],
    expected: { amount: '1500', from: 'List price', minQuantity: '1', line: '6000' },
  },
];

const contractYear = {
  activeFrom: '2026-04-01T00:00:00.000Z',
  activeUntil: '2027-04-01T00:00:00.000Z',
};
const dated = [
  contract([['each', '1', '70.00']], contractYear),
  websiteList([['each', '1', '80.00']]),
];
const promo = [
  websiteList([['each', '1', '72.00']], {
    name: 'Diwali promo',
    priority: 1,
    activeFrom: '2026-10-20T00:00:00.000Z',
    activeUntil: '2026-11-05T00:00:00.000Z',
  }),
  websiteList([['each', '1', '80.00']], { priority: 2 }),
];

export const DATE_CASES: readonly PriceCase[] = [
  {
    title: 'a second before a contract starts, the website prices',
    ...each('1', dated),
    now: '2026-03-31T23:59:59.000Z',
    expected: { amount: '80.00', from: 'List price', minQuantity: '1', line: '80.00' },
  },
  {
    title: 'the instant a contract starts, it prices (from is inclusive)',
    ...each('1', dated),
    now: '2026-04-01T00:00:00.000Z',
    expected: { amount: '70.00', from: 'Customer contract', minQuantity: '1', line: '70.00' },
  },
  {
    title: 'a second before a contract ends, it still prices',
    ...each('1', dated),
    now: '2027-03-31T23:59:59.000Z',
    expected: { amount: '70.00', from: 'Customer contract', minQuantity: '1', line: '70.00' },
  },
  {
    title: 'the instant a contract ends, the website prices (until is exclusive)',
    ...each('1', dated),
    now: '2027-04-01T00:00:00.000Z',
    expected: { amount: '80.00', from: 'List price', minQuantity: '1', line: '80.00' },
  },
  {
    title: 'a running promotion goes first on the website',
    ...each('1', promo),
    now: '2026-11-04T23:59:59.000Z',
    expected: { amount: '72.00', from: 'Diwali promo', minQuantity: '1', line: '72.00' },
  },
  {
    title: 'after the promotion the list price is back, without a rebuild',
    ...each('1', promo),
    now: '2026-11-05T00:00:00.000Z',
    expected: { amount: '80.00', from: 'List price', minQuantity: '1', line: '80.00' },
  },
  {
    title: 'before the promotion the list price applies',
    ...each('1', promo),
    now: '2026-10-19T23:59:59.000Z',
    expected: { amount: '80.00', from: 'List price', minQuantity: '1', line: '80.00' },
  },
];

const perKg = (amount: string) => [websiteList([['kg', '0.001', amount]])];

export const ROUNDING_CASES: readonly PriceCase[] = [
  {
    title: '2.5 kg at 33.33 is 83.325, rounded half up to 83.33',
    currency: 'INR',
    unit: 'kg',
    quantity: '2.5',
    now: NOW,
    lists: perKg('33.33'),
    expected: { amount: '33.33', from: 'List price', minQuantity: '0.001', line: '83.33' },
  },
  {
    title: '0.335 kg at 1.00 is 0.335, rounded half up to 0.34',
    currency: 'INR',
    unit: 'kg',
    quantity: '0.335',
    now: NOW,
    lists: perKg('1.00'),
    expected: { amount: '1.00', from: 'List price', minQuantity: '0.001', line: '0.34' },
  },
  {
    title: '0.334 kg at 1.00 is 0.334, rounded down to 0.33',
    currency: 'INR',
    unit: 'kg',
    quantity: '0.334',
    now: NOW,
    lists: perKg('1.00'),
    expected: { amount: '1.00', from: 'List price', minQuantity: '0.001', line: '0.33' },
  },
  {
    title: '0.125 kg at 0.10 is 0.0125, rounded to 0.01',
    currency: 'INR',
    unit: 'kg',
    quantity: '0.125',
    now: NOW,
    lists: perKg('0.10'),
    expected: { amount: '0.10', from: 'List price', minQuantity: '0.001', line: '0.01' },
  },
  {
    title: '0.5 kg at JPY 1001 is 500.5, rounded half up to 501',
    currency: 'JPY',
    unit: 'kg',
    quantity: '0.5',
    now: NOW,
    lists: perKg('1001'),
    expected: { amount: '1001', from: 'List price', minQuantity: '0.001', line: '501' },
  },
  {
    title: '0.001 kg at 0.01 is 0.00001, rounded to zero',
    currency: 'INR',
    unit: 'kg',
    quantity: '0.001',
    now: NOW,
    lists: perKg('0.01'),
    expected: { amount: '0.01', from: 'List price', minQuantity: '0.001', line: '0.00' },
  },
  {
    title: 'a zero price stays zero',
    ...each('12', [websiteList([['each', '1', '0.00']])]),
    expected: { amount: '0.00', from: 'List price', minQuantity: '1', line: '0.00' },
  },
];

export const ALL_CASES: readonly PriceCase[] = [
  ...FALLBACK_CASES,
  ...TIER_CASES,
  ...CURRENCY_CASES,
  ...DATE_CASES,
  ...ROUNDING_CASES,
];

/** The chain order: customer, then customer group, then website, each by priority. */
export function chainOrder(lists: readonly ListSpec[]): ListSpec[] {
  const rank = { customer: 1, customer_group: 2, website: 3 } as const;
  return [...lists].sort((a, b) => rank[a.target] - rank[b.target] || a.priority - b.priority);
}
