import { isUsStateCode, isValidGstin } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { findWebsite } from '@muziris/platform';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { registrations } from './db/schema.js';
import { isUniqueViolation, TaxError } from './errors.js';

// Where each website's seller is registered to charge tax (ADR 0017). The admin API checks
// tax.manage before calling the functions that change them.

export interface Registration {
  id: string;
  websiteId: string;
  regime: 'gst' | 'us_sales_tax';
  regionCode: string;
  number: string;
  createdAt: Date;
  updatedAt: Date;
}

export const gstRegistrationSchema = z.object({
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isValidGstin, 'Not a valid GSTIN: check its format, state code and check character'),
});

export const usRegistrationSchema = z.object({
  stateCode: z.string().trim().toUpperCase().refine(isUsStateCode, 'Not a US state code'),
  permitNumber: z.string().trim().min(1).max(64),
});

function toRegistration(row: typeof registrations.$inferSelect): Registration {
  if (row.regime !== 'gst' && row.regime !== 'us_sales_tax') {
    throw new Error(`Registration ${row.id} has an unknown regime`);
  }
  return { ...row, regime: row.regime };
}

async function websiteIn(db: Database, websiteId: string, countryCode: 'IN' | 'US') {
  const website = await findWebsite(db, websiteId);
  if (!website) throw new TaxError('website_not_found', 'No such website');
  if (website.countryCode !== countryCode) {
    throw new TaxError(
      'wrong_regime',
      countryCode === 'IN'
        ? 'Only a website in India has a GST registration'
        : 'Only a website in the US has sales tax permits',
    );
  }
  return website;
}

/** Sets the website's GSTIN, replacing any it had: a website has one GST registration. */
export async function setGstRegistration(
  db: Database,
  websiteId: string,
  input: z.input<typeof gstRegistrationSchema>,
): Promise<Registration> {
  const { gstin } = gstRegistrationSchema.parse(input);
  const website = await websiteIn(db, websiteId, 'IN');
  return db.transaction(async (tx) => {
    const regionCode = gstin.slice(0, 2);
    await tx
      .delete(registrations)
      .where(
        and(
          eq(registrations.websiteId, website.id),
          eq(registrations.regime, 'gst'),
          ne(registrations.regionCode, regionCode),
        ),
      );
    const [row] = await tx
      .insert(registrations)
      .values({ websiteId: website.id, regime: 'gst', regionCode, number: gstin })
      .onConflictDoUpdate({
        target: [registrations.websiteId, registrations.regime, registrations.regionCode],
        set: { number: gstin, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('Registration upsert returned no row');
    return toRegistration(row);
  });
}

/** Adds a US state the website's seller collects sales tax in, with its permit number. */
export async function addUsRegistration(
  db: Database,
  websiteId: string,
  input: z.input<typeof usRegistrationSchema>,
): Promise<Registration> {
  const values = usRegistrationSchema.parse(input);
  const website = await websiteIn(db, websiteId, 'US');
  try {
    const [row] = await db
      .insert(registrations)
      .values({
        websiteId: website.id,
        regime: 'us_sales_tax',
        regionCode: values.stateCode,
        number: values.permitNumber,
      })
      .returning();
    if (!row) throw new Error('Registration insert returned no row');
    return toRegistration(row);
  } catch (error) {
    if (isUniqueViolation(error, 'tax_registration_website_region_uq')) {
      throw new TaxError('registration_taken', 'The website already has a permit for this state');
    }
    throw error;
  }
}

export async function listRegistrations(
  db: Pick<Database, 'select'>,
  websiteId: string,
): Promise<Registration[]> {
  if (!z.uuid().safeParse(websiteId).success) return [];
  const rows = await db
    .select()
    .from(registrations)
    .where(eq(registrations.websiteId, websiteId))
    .orderBy(asc(registrations.regime), asc(registrations.regionCode));
  return rows.map(toRegistration);
}

export async function deleteRegistration(db: Database, registrationId: string): Promise<void> {
  const id = z.uuid().safeParse(registrationId);
  const deleted = id.success
    ? await db
        .delete(registrations)
        .where(eq(registrations.id, id.data))
        .returning({ id: registrations.id })
    : [];
  if (deleted.length === 0) throw new TaxError('registration_not_found', 'No such registration');
}
