import { defineSetting } from '@muziris/platform';
import { z } from 'zod';
import { PAYMENT_METHODS, type PaymentMethod } from './payment-methods.js';

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
 * ({ amount: "250.00" }); "0" ships free.
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

/** The prefix of order numbers, for example MZ in MZ-000123. */
export const ORDER_NUMBER_PREFIX = defineSetting({
  key: 'orders.number_prefix',
  description: 'Prefix of order numbers, such as MZ in MZ-000123',
  schema: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Use 1 to 10 capital letters or digits, starting with a letter'),
  defaultValue: 'MZ',
  allowedScopes: ['website', 'organization', 'global'],
});

/**
 * How customers may pay (ADR 0019), in the order checkout offers them. A gateway method is
 * offered only when its keys are configured and it takes the order's currency.
 */
export const PAYMENT_METHODS_SETTING = defineSetting<PaymentMethod[]>({
  key: 'payment.methods',
  description: 'Payment methods checkout offers: terms, stripe_card, stripe_ach, razorpay',
  schema: z.array(z.enum(PAYMENT_METHODS)).max(PAYMENT_METHODS.length),
  defaultValue: ['terms'],
  allowedScopes: ['customer', 'customer_group', 'website', 'organization', 'global'],
});
