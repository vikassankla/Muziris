import type { Database } from '@muziris/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  GST_STATE_CODES,
  gstinProblem,
  isGstStateCode,
  isUsStateCode,
  normalizePinCode,
  normalizeZipCode,
} from './address-rules.js';
import { addresses } from './db/schema.js';
import { CustomerError, isForeignKeyViolation, isUniqueViolation } from './errors.js';
import { pageQuerySchema, toPage, type PageQuery } from './page.js';

export type Address = typeof addresses.$inferSelect;

const GSTIN_MESSAGES = {
  format: 'Use a 15-character GSTIN such as 27AAPFU0939F1ZV',
  state_code: 'The GSTIN starts with an unknown GST state code',
  check_character: 'The GSTIN check character is wrong; check for a typing mistake',
} as const;

const common = {
  customerId: z.uuid(),
  label: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(200),
  line2: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .default(null),
  city: z.string().trim().min(1).max(100),
  isDefaultBilling: z.boolean().default(false),
  isDefaultShipping: z.boolean().default(false),
};

const upper = (v: string) => v.trim().toUpperCase();

const indiaAddress = z
  .object({
    ...common,
    countryCode: z.literal('IN'),
    regionCode: z
      .string()
      .trim()
      .refine(isGstStateCode, 'Use a two-digit GST state code such as 27 for Maharashtra'),
    postalCode: z.string().transform((value, ctx) => {
      const pin = normalizePinCode(value);
      if (pin === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Use a six-digit PIN code such as 560001' });
        return z.NEVER;
      }
      return pin;
    }),
    gstin: z
      .string()
      .transform(upper)
      .superRefine((value, ctx) => {
        const problem = gstinProblem(value);
        if (problem !== undefined)
          ctx.addIssue({ code: 'custom', message: GSTIN_MESSAGES[problem] });
      })
      .nullable()
      .default(null),
  })
  .superRefine((address, ctx) => {
    if (address.gstin !== null && !address.gstin.startsWith(address.regionCode)) {
      const state = GST_STATE_CODES[address.regionCode];
      ctx.addIssue({
        code: 'custom',
        path: ['gstin'],
        message: `A GSTIN for an address in ${state} starts with ${address.regionCode}`,
      });
    }
  });

const usAddress = z.object({
  ...common,
  countryCode: z.literal('US'),
  regionCode: z
    .string()
    .transform(upper)
    .refine(isUsStateCode, 'Use a two-letter state code such as CA'),
  postalCode: z.string().transform((value, ctx) => {
    const zip = normalizeZipCode(value);
    if (zip === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Use a ZIP code such as 94105 or 94105-1234' });
      return z.NEVER;
    }
    return zip;
  }),
  gstin: z.null().default(null),
});

export const newAddressSchema = z.discriminatedUnion('countryCode', [indiaAddress, usAddress]);

export type NewAddress = z.input<typeof newAddressSchema>;

/**
 * Adds an address to a customer. Making it the default billing or shipping address takes that
 * role away from the customer's previous default in the same transaction.
 */
export async function addAddress(db: Database, input: NewAddress): Promise<Address> {
  const values = newAddressSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      if (values.isDefaultBilling) {
        await tx
          .update(addresses)
          .set({ isDefaultBilling: false, updatedAt: sql`now()` })
          .where(
            and(eq(addresses.customerId, values.customerId), eq(addresses.isDefaultBilling, true)),
          );
      }
      if (values.isDefaultShipping) {
        await tx
          .update(addresses)
          .set({ isDefaultShipping: false, updatedAt: sql`now()` })
          .where(
            and(eq(addresses.customerId, values.customerId), eq(addresses.isDefaultShipping, true)),
          );
      }
      const [row] = await tx.insert(addresses).values(values).returning();
      if (!row) throw new Error('Address insert returned no row');
      return row;
    });
  } catch (error) {
    if (isForeignKeyViolation(error))
      throw new CustomerError('customer_not_found', 'No such customer');
    if (isUniqueViolation(error)) {
      throw new CustomerError(
        'default_address_conflict',
        'Another default address was set at the same time; try again',
      );
    }
    throw error;
  }
}

/** Order for address lists: defaults first, then by label. */
export const addressOrder = [
  desc(addresses.isDefaultBilling),
  desc(addresses.isDefaultShipping),
  asc(addresses.label),
  asc(addresses.id),
];

export interface AddressPage {
  addresses: Address[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

/**
 * A customer's addresses in addressOrder, a page at a time, for the admin. Storefront reads go
 * through buyer-scope.ts.
 */
export async function listAddresses(
  db: Database,
  customerId: string,
  query: PageQuery = {},
): Promise<AddressPage> {
  const q = pageQuerySchema.parse(query);
  // The same order as addressOrder, written ascending so one row comparison continues it.
  const key = sql`(not ${addresses.isDefaultBilling}, not ${addresses.isDefaultShipping}, ${addresses.label}, ${addresses.id})`;
  const rows = await db
    .select()
    .from(addresses)
    .where(
      and(
        eq(addresses.customerId, z.uuid().parse(customerId)),
        q.after === undefined
          ? undefined
          : sql`${key} > (select not is_default_billing, not is_default_shipping, label, id from ${addresses} where id = ${q.after})`,
      ),
    )
    .orderBy(...addressOrder)
    .limit(q.limit + 1);
  const { items, nextAfter } = toPage(rows, q.limit, (r) => r.id);
  return { addresses: items, nextAfter };
}
