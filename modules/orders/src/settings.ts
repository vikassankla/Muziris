import { defineSetting } from '@muziris/platform';
import { z } from 'zod';

// Settings checkout reads (ADR 0016), resolved customer, customer group, website, organization
// and global, as ADR 0003 does.

/** Days a customer has to pay an order placed on terms: 30 is net 30, 0 is due on placing. */
export const PAYMENT_TERM_DAYS = defineSetting({
  key: 'payment.term_days',
  description: 'Days a customer has to pay an order placed on payment terms',
  schema: z.int().min(0).max(365),
  defaultValue: 30,
  allowedScopes: ['customer', 'customer_group', 'website', 'organization', 'global'],
});

/**
 * The flat shipping charge per order, in major units of the website's currency
 * ({ amount: "250.00" }); "0" ships free. An object, not a bare string: the jsonb column reads a
 * string that looks like a number back as a number.
 */
export const SHIPPING_FLAT_RATE = defineSetting({
  key: 'shipping.flat_rate',
  description: 'Flat shipping charge per order, in the website currency',
  schema: z.object({
    amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use a decimal amount such as 250.00'),
  }),
  defaultValue: { amount: '0' },
  allowedScopes: ['website', 'organization', 'global'],
});

/**
 * The prefix of order numbers, for example MZ in MZ-000123. It starts with a letter, so the jsonb
 * column can never read it back as a number.
 */
export const ORDER_NUMBER_PREFIX = defineSetting({
  key: 'orders.number_prefix',
  description: 'Prefix of order numbers, such as MZ in MZ-000123',
  schema: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Use 1 to 10 capital letters or digits, starting with a letter'),
  defaultValue: 'MZ',
  allowedScopes: ['website', 'organization', 'global'],
});
