import { describe, expect, it } from 'vitest';
import { persistedQueriesFrom, queryHash } from './persisted.js';

describe('persisted queries', () => {
  const text = '{ website { code } }';

  it('hashes the exact text with SHA-256', () => {
    expect(queryHash(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(queryHash(text)).not.toBe(queryHash(`${text} `));
  });

  it('accepts a registry whose keys are the hashes of their documents', () => {
    expect(persistedQueriesFrom({ [queryHash(text)]: text }).get(queryHash(text))).toBe(text);
  });

  it('refuses a document filed under another hash', () => {
    expect(() => persistedQueriesFrom({ [queryHash(text)]: '{ viewer { email } }' })).toThrow(
      /does not match/,
    );
  });

  it.each([[[]], [{ 'not-a-hash': text }], [{ [queryHash(text)]: '' }], ['text']])(
    'refuses a malformed registry %j',
    (value) => {
      expect(() => persistedQueriesFrom(value)).toThrow();
    },
  );
});
