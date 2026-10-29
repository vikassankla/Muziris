import { PRODUCT_STATUSES } from '@muziris/catalog';
import { z } from 'zod';

// Turning what a person typed into the pieces the search statement needs (ADR 0013). Nothing here
// touches the database. Words come out as letters and digits only, so they can be given to
// `to_tsquery` as parameters without any risk of query syntax getting through.

export const MAX_QUERY_LENGTH = 100;
export const MAX_QUERY_WORDS = 8;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;
/** No result after this many can be reached, however the pages are asked for. */
export const MAX_RESULTS = 1000;

/**
 * Common English words that say nothing about a product. The text tier drops them from the
 * query, because the `simple` half of the document keeps them and would otherwise require them.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/**
 * Indian (and British) English and US English spellings of the same thing. A query word that
 * has a pair also matches it, so a product named either way is found by either.
 */
const SPELLING_PAIRS: readonly (readonly [string, string])[] = [
  ['aluminium', 'aluminum'],
  ['colour', 'color'],
  ['colours', 'colors'],
  ['grey', 'gray'],
  ['tyre', 'tire'],
  ['tyres', 'tires'],
  ['metre', 'meter'],
  ['metres', 'meters'],
  ['litre', 'liter'],
  ['litres', 'liters'],
  ['spanner', 'wrench'],
  ['spanners', 'wrenches'],
  ['fibre', 'fiber'],
  ['centre', 'center'],
  ['mould', 'mold'],
  ['sulphur', 'sulfur'],
];

const PAIRS: ReadonlyMap<string, string> = new Map(
  SPELLING_PAIRS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
);

export interface ParsedQuery {
  /** The whole query, normalized and in lower case, for comparing with SKUs. */
  text: string;
  /**
   * The words to look up, at most MAX_QUERY_WORDS, each with its spellings: the word itself
   * first, then its pair in the other spelling, if any. Empty when the query has no words that
   * say anything (only stop words or punctuation).
   */
  words: string[][];
}

/** Normalizes a query and splits it into words of letters and digits. */
export function parseQuery(query: string): ParsedQuery {
  const text = query.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  const seen = new Set<string>();
  const words: string[][] = [];
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word === '' || STOP_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    const pair = PAIRS.get(word);
    words.push(pair === undefined ? [word] : [word, pair]);
    if (words.length === MAX_QUERY_WORDS) break;
  }
  return { text, words };
}

/** Escapes `%`, `_` and `\` so a text is matched literally by LIKE with `escape '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const pageFields = {
  q: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  limit: z.int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  offset: z
    .int()
    .min(0)
    .max(MAX_RESULTS - 1)
    .default(0),
};

function withinResults(value: { limit: number; offset: number }): boolean {
  return value.offset + value.limit <= MAX_RESULTS;
}

const beyondResults = {
  message: `Only the first ${MAX_RESULTS} results can be read`,
  path: ['offset'],
};

export const searchQuerySchema = z.object(pageFields).refine(withinResults, beyondResults);

export type SearchQuery = z.input<typeof searchQuerySchema>;

export const adminSearchQuerySchema = z
  .object({ ...pageFields, status: z.enum(PRODUCT_STATUSES).optional() })
  .refine(withinResults, beyondResults);

export type AdminSearchQuery = z.input<typeof adminSearchQuerySchema>;
