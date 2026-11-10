import { ORDER_EMAIL_SETTING } from '@muziris/notifications';
import {
  ORDER_NUMBER_PREFIX,
  PAYMENT_METHODS,
  PAYMENT_METHODS_SETTING,
  PAYMENT_TERM_DAYS,
  SHIPPING_FLAT_RATE,
} from '@muziris/orders';
import { defineSetting, type SettingDefinition } from '@muziris/platform';
import { z } from 'zod';

// The settings an admin may change (ADR 0021), each listed once with how the admin app edits
// it. A setting not listed here cannot be changed through the API. Secrets are environment
// variables, never settings.

/** The buyer role given to invited buyers when they accept; none by default. */
export const DEFAULT_BUYER_ROLE = defineSetting<string | null>({
  key: 'customers.default_buyer_role',
  description: 'Buyer role given to invited buyers when they accept the invitation',
  schema: z.uuid().nullable(),
  defaultValue: null,
  allowedScopes: ['website', 'organization'],
});

export const SETTING_GROUPS = [
  'Checkout',
  'Payments',
  'Shipping',
  'Orders',
  'Emails',
  'Customers',
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** How the admin app shows and edits a value. */
export type SettingEditor =
  | { kind: 'integer'; min: number; max: number; unit?: string }
  | { kind: 'money' }
  | { kind: 'text'; pattern?: string }
  | { kind: 'email'; allowEmpty: boolean }
  | { kind: 'choices'; multiple: boolean; options: { value: string; label: string }[] }
  | { kind: 'boolean' }
  | { kind: 'buyer_role' };

export interface AdminSetting {
  definition: SettingDefinition<unknown>;
  group: SettingGroup;
  label: string;
  editor: SettingEditor;
}

export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  terms: 'On payment terms',
  stripe_card: 'Card (Stripe)',
  stripe_ach: 'US bank account (Stripe)',
  razorpay: 'Razorpay',
};

const setting = <T>(
  definition: SettingDefinition<T>,
  rest: Omit<AdminSetting, 'definition'>,
): AdminSetting => ({ definition, ...rest });

export const ADMIN_SETTINGS: readonly AdminSetting[] = [
  setting(PAYMENT_METHODS_SETTING, {
    group: 'Payments',
    label: 'Payment methods',
    editor: {
      kind: 'choices',
      multiple: true,
      options: PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] })),
    },
  }),
  setting(PAYMENT_TERM_DAYS, {
    group: 'Payments',
    label: 'Payment term',
    editor: { kind: 'integer', min: 0, max: 365, unit: 'days' },
  }),
  setting(SHIPPING_FLAT_RATE, {
    group: 'Shipping',
    label: 'Flat shipping charge per order',
    editor: { kind: 'money' },
  }),
  setting(ORDER_NUMBER_PREFIX, {
    group: 'Orders',
    label: 'Order number prefix',
    editor: { kind: 'text', pattern: '^[A-Z][A-Z0-9]{0,9}$' },
  }),
  setting(ORDER_EMAIL_SETTING, {
    group: 'Emails',
    label: 'New order emails to',
    editor: { kind: 'email', allowEmpty: true },
  }),
  setting(DEFAULT_BUYER_ROLE, {
    group: 'Customers',
    label: 'Buyer role for invited buyers',
    editor: { kind: 'buyer_role' },
  }),
];

export function findAdminSetting(key: string): AdminSetting | undefined {
  return ADMIN_SETTINGS.find((s) => s.definition.key === key);
}
