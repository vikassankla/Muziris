/**
 * Currencies the platform can price in, with their ISO 4217 minor-unit exponent.
 * Add a currency here only after checking its exponent against ISO 4217.
 */
export const CURRENCIES = {
  INR: { code: 'INR', exponent: 2 },
  USD: { code: 'USD', exponent: 2 },
  EUR: { code: 'EUR', exponent: 2 },
  GBP: { code: 'GBP', exponent: 2 },
  AED: { code: 'AED', exponent: 2 },
  SGD: { code: 'SGD', exponent: 2 },
  JPY: { code: 'JPY', exponent: 0 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

export function currencyExponent(code: CurrencyCode): number {
  return CURRENCIES[code].exponent;
}
