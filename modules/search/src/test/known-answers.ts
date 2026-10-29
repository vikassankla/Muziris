import type { Match } from '../search.js';

// Known-answer tables for search (ADR 0013). The catalog is small and fixed, so each query's
// first results can be written down. The leakage table is the security half: none of its queries
// may ever return a product hidden from the buyer.

export interface CatalogProduct {
  sku: string;
  name: string;
  category: CategoryCode | null;
  attributes?: Record<string, string | string[] | boolean>;
  status?: 'enabled' | 'disabled';
}

export const CATEGORIES = {
  power_transmission: { name: 'Power transmission', parent: null },
  bearings: { name: 'Bearings', parent: 'power_transmission' },
  safety: { name: 'Safety', parent: null },
  gloves: { name: 'Hand protection', parent: 'safety' },
  tools: { name: 'Hand tools', parent: null },
  metals: { name: 'Metals', parent: null },
} as const satisfies Record<string, { name: string; parent: string | null }>;

export type CategoryCode = keyof typeof CATEGORIES;

/** Parents before children, so they can be created in this order. */
export const CATEGORY_ORDER: readonly CategoryCode[] = [
  'power_transmission',
  'bearings',
  'safety',
  'gloves',
  'tools',
  'metals',
];

export const CATALOG: readonly CatalogProduct[] = [
  {
    sku: 'BRG-6205',
    name: 'Ball bearing 6205 open',
    category: 'bearings',
    attributes: { bore: '25 mm' },
  },
  {
    sku: 'BRG-6205-2RS',
    name: 'Ball bearing 6205-2RS sealed',
    category: 'bearings',
    attributes: { bore: '25 mm', seal: 'rubber' },
  },
  { sku: 'BRG-6206-ZZ', name: 'Ball bearing 6206-ZZ shielded', category: 'bearings' },
  { sku: 'SLV-H305', name: 'Adapter sleeve for BRG 6205', category: 'bearings' },
  { sku: 'XBRG-6205', name: 'Puller kit', category: 'tools' },
  {
    sku: 'GLV-NIT-L',
    name: 'Nitrile gloves, large',
    category: 'gloves',
    attributes: { colours: ['blue', 'black'], certified: true },
  },
  { sku: 'SPN-17', name: 'Combination spanner 17 mm', category: 'tools' },
  { sku: 'WRN-ADJ-10', name: 'Adjustable wrench 10 inch', category: 'tools' },
  { sku: 'AL-SHEET-2', name: 'Aluminium sheet 2 mm', category: 'metals' },
  { sku: 'AL-ROD-10', name: 'Aluminum rod 10 mm', category: 'metals' },
  { sku: 'MS-PLT-EN8', name: 'Mild steel plate', category: 'metals', attributes: { grade: 'EN8' } },
  { sku: 'BRG-OLD-1', name: 'Ball bearing discontinued', category: 'bearings', status: 'disabled' },
];

export interface RankingCase {
  q: string;
  why: string;
  /** The first results, in order, with how each matched. Later results are not checked. */
  first: readonly (readonly [sku: string, match: Match])[];
}

/**
 * Admin search over the whole catalog. Exact SKU first, then SKU prefix, then text matches,
 * then close matches (typos, partial SKUs).
 */
export const RANKING_CASES: readonly RankingCase[] = [
  {
    q: 'BRG-6205',
    why: 'every tier at once: exact, prefix, text in a name, then a SKU that contains it',
    first: [
      ['BRG-6205', 'sku_exact'],
      ['BRG-6205-2RS', 'sku_prefix'],
      ['SLV-H305', 'text'],
      ['XBRG-6205', 'close'],
    ],
  },
  {
    q: 'brg-6205-2rs',
    why: 'an exact SKU in another letter case',
    first: [['BRG-6205-2RS', 'sku_exact']],
  },
  {
    q: 'BRG-62',
    why: 'a SKU prefix, in SKU order',
    first: [
      ['BRG-6205', 'sku_prefix'],
      ['BRG-6205-2RS', 'sku_prefix'],
      ['BRG-6206-ZZ', 'sku_prefix'],
    ],
  },
  {
    q: 'sealed bearing',
    why: 'name words in any order, the English stem of a word',
    first: [['BRG-6205-2RS', 'text']],
  },
  {
    q: 'bearings',
    why: 'a plural finds the singular through the english configuration',
    first: [
      ['BRG-6205', 'text'],
      ['BRG-6205-2RS', 'text'],
      ['BRG-6206-ZZ', 'text'],
    ],
  },
  {
    q: 'power transmission',
    why: 'a category above the product; an admin sees disabled products too',
    first: [
      ['BRG-6205', 'text'],
      ['BRG-6205-2RS', 'text'],
      ['BRG-6206-ZZ', 'text'],
      ['BRG-OLD-1', 'text'],
      ['SLV-H305', 'text'],
    ],
  },
  {
    q: 'aluminum',
    why: 'the US spelling finds both spellings',
    first: [
      ['AL-ROD-10', 'text'],
      ['AL-SHEET-2', 'text'],
    ],
  },
  {
    q: 'aluminium',
    why: 'the Indian English spelling finds both spellings',
    first: [
      ['AL-ROD-10', 'text'],
      ['AL-SHEET-2', 'text'],
    ],
  },
  {
    q: 'spanner',
    why: 'spanner and wrench are one tool',
    first: [
      ['SPN-17', 'text'],
      ['WRN-ADJ-10', 'text'],
    ],
  },
  {
    q: 'EN8',
    why: 'an attribute value, not stemmed',
    first: [['MS-PLT-EN8', 'text']],
  },
  {
    q: 'nitr',
    why: 'the last word is a prefix while typing',
    first: [['GLV-NIT-L', 'text']],
  },
  {
    q: 'bearng',
    why: 'a typo is a close match',
    first: [
      ['BRG-6205', 'close'],
      ['BRG-6205-2RS', 'close'],
      ['BRG-6206-ZZ', 'close'],
    ],
  },
  {
    q: 'nitrle gloves',
    why: 'a typo in one word of two',
    first: [['GLV-NIT-L', 'close']],
  },
  {
    q: '205-2R',
    why: 'a partial SKU from the middle',
    first: [['BRG-6205-2RS', 'close']],
  },
];

/**
 * Queries a retail buyer tries. Bearings are hidden from them on the website (the
 * distributors' group is shown them), the gloves are hidden from their customer alone, and one
 * bearing is disabled. Every phrasing must come back without any of those.
 */
export const LEAKAGE_QUERIES: readonly string[] = [
  'BRG-6205',
  'brg-6205-2rs',
  'BRG-6206-ZZ',
  'BRG-OLD-1',
  'brg',
  'BRG-',
  'B',
  '6205',
  '205-2R',
  'ball bearing',
  'bearings',
  'bearng',
  'sealed',
  'rubber',
  '25 mm',
  'power transmission',
  'GLV-NIT-L',
  'GLV',
  'nitrile',
  'gloves',
  'blue',
  'hand protection',
  'discontinued',
  '%',
  '_',
  'BRG%',
  'BRG_6205',
  '\\',
  "' or 1=1 --",
  'bearing | glove',
  'bearing & !glove',
  'bearing:*',
  '*',
];

/** Products the retail buyer must never see. */
export const HIDDEN_FROM_RETAIL: readonly string[] = [
  'BRG-6205',
  'BRG-6205-2RS',
  'BRG-6206-ZZ',
  'SLV-H305',
  'BRG-OLD-1',
  'GLV-NIT-L',
];
