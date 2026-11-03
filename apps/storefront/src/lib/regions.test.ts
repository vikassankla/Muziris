import { describe, expect, it } from 'vitest';
import { regionLabel } from './regions.js';

describe('regionLabel', () => {
  it('names an Indian state from its GST code and keeps the code', () => {
    expect(regionLabel('IN', '27')).toBe('Maharashtra (27)');
  });

  it('keeps a US state abbreviation, and an unknown code, as they are', () => {
    expect(regionLabel('US', 'TX')).toBe('TX');
    expect(regionLabel('IN', '99')).toBe('99');
  });
});
