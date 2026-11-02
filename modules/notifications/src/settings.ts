import { defineSetting } from '@muziris/platform';
import { z } from 'zod';

/** Where the seller hears of new orders (ADR 0020): one address, or empty for no email. */
export const ORDER_EMAIL_SETTING = defineSetting({
  key: 'notifications.order_email',
  description: 'Email address told of each new order; empty sends none',
  schema: z.union([z.literal(''), z.email().max(254)]),
  defaultValue: '',
  allowedScopes: ['website', 'organization', 'global'],
});
