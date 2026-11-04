import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect.js';

describe('safeRedirect', () => {
  it('keeps a path inside the app, with its query and fragment', () => {
    expect(safeRedirect('/orders/SO-1001?tab=lines#notes')).toBe('/orders/SO-1001?tab=lines#notes');
    expect(safeRedirect('/')).toBe('/');
  });

  it('refuses anything a browser would take to another site', () => {
    for (const value of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\n/evil.example',
      ' /evil',
      'javascript:alert(1)',
    ]) {
      expect(safeRedirect(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('refuses the sign-in pages and anything that is not a string', () => {
    expect(safeRedirect('/sign-in')).toBeUndefined();
    expect(safeRedirect('/sign-in/two-factor')).toBeUndefined();
    expect(safeRedirect(undefined)).toBeUndefined();
    expect(safeRedirect(['/orders'])).toBeUndefined();
  });
});
