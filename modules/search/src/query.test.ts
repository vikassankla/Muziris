import { describe, expect, it } from 'vitest';
import {
  adminSearchQuerySchema,
  escapeLike,
  MAX_QUERY_WORDS,
  MAX_RESULTS,
  parseQuery,
  searchQuerySchema,
} from './query.js';

describe('parseQuery', () => {
  it.each([
    ['BRG-6205-2RS', 'brg-6205-2rs', [['brg'], ['6205'], ['2rs']]],
    ['  Ball   Bearing ', 'ball bearing', [['ball'], ['bearing']]],
    ['gloves for the welder', 'gloves for the welder', [['gloves'], ['welder']]],
    ['the of and', 'the of and', []],
    ['Aluminium sheet', 'aluminium sheet', [['aluminium', 'aluminum'], ['sheet']]],
    ['aluminum', 'aluminum', [['aluminum', 'aluminium']]],
    ['Spanner', 'spanner', [['spanner', 'wrench']]],
    ['bolt bolt BOLT', 'bolt bolt bolt', [['bolt']]],
    ['ＢＲＧ－６２０５', 'brg-6205', [['brg'], ['6205']]],
    ['Śaka bolt', 'śaka bolt', [['śaka'], ['bolt']]],
    ["' or 1=1 --", "' or 1=1 --", [['1']]],
    ['bearing:* & !glove | (x)', 'bearing:* & !glove | (x)', [['bearing'], ['glove'], ['x']]],
    ['%_\\', '%_\\', []],
  ])('%j reads as %j with words %j', (query, text, words) => {
    expect(parseQuery(query)).toEqual({ text, words });
  });

  it('keeps words of letters and digits only, so to_tsquery sees no operators', () => {
    const { words } = parseQuery(`a:b c&d e|f !g (h) 'i' "j" <k> l\\m n*`);
    for (const spellings of words) {
      for (const word of spellings) expect(word).toMatch(/^[\p{L}\p{N}]+$/u);
    }
  });

  it(`keeps at most ${MAX_QUERY_WORDS} words`, () => {
    const { words } = parseQuery('a1 a2 a3 a4 a5 a6 a7 a8 a9 a10');
    expect(words.map((w) => w[0])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
  });
});

describe('escapeLike', () => {
  it.each([
    ['BRG-6205', 'BRG-6205'],
    ['100%', '100\\%'],
    ['A_B', 'A\\_B'],
    ['a\\b', 'a\\\\b'],
  ])('%j becomes %j', (value, escaped) => {
    expect(escapeLike(value)).toBe(escaped);
  });
});

describe('search query schemas', () => {
  it('defaults to the first 20 results', () => {
    expect(searchQuerySchema.parse({ q: ' bearing ' })).toEqual({
      q: 'bearing',
      limit: 20,
      offset: 0,
    });
  });

  it.each([
    [{ q: '' }],
    [{ q: '   ' }],
    [{ q: 'x'.repeat(101) }],
    [{ q: 'x', limit: 0 }],
    [{ q: 'x', limit: 51 }],
    [{ q: 'x', offset: -1 }],
    [{ q: 'x', limit: 50, offset: MAX_RESULTS - 49 }],
    [{ q: 'x', limit: 1.5 }],
  ])('refuses %j', (query) => {
    expect(searchQuerySchema.safeParse(query).success).toBe(false);
  });

  it('reaches the last result and no further', () => {
    expect(
      searchQuerySchema.safeParse({ q: 'x', limit: 50, offset: MAX_RESULTS - 50 }).success,
    ).toBe(true);
  });

  it('lets an admin filter by status', () => {
    expect(adminSearchQuerySchema.parse({ q: 'x', status: 'disabled' }).status).toBe('disabled');
    expect(adminSearchQuerySchema.safeParse({ q: 'x', status: 'archived' }).success).toBe(false);
  });
});
