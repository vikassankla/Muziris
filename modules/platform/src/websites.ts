import type { Database } from '@muziris/db';
import { isCurrencyCode } from '@muziris/money';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { organizations, websites } from './db/schema.js';

/**
 * Accepts any IANA zone the runtime knows, including aliases such as Asia/Kolkata
 * (Intl.supportedValuesOf lists only one canonical spelling per zone).
 */
function isTimeZone(value: string): boolean {
  if (!value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A website locale is a language plus a country, for example en-IN, hi-IN or en-US. */
const WEBSITE_LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/;

function isCanonicalLocale(value: string): boolean {
  if (!WEBSITE_LOCALE_PATTERN.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

export const newWebsiteSchema = z.object({
  organizationId: z.uuid(),
  code: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use 2 to 63 lowercase letters, digits or hyphens'),
  name: z.string().trim().min(1).max(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 code such as IN or US'),
  defaultCurrency: z.string().refine(isCurrencyCode, 'Unsupported currency'),
  defaultLocale: z.string().refine(isCanonicalLocale, 'Use a canonical locale such as en-IN'),
  timeZone: z.string().refine(isTimeZone, 'Use an IANA time zone such as Asia/Kolkata'),
  unitSystem: z.enum(['metric', 'imperial']).default('metric'),
});

export type NewWebsite = z.input<typeof newWebsiteSchema>;
export type Website = typeof websites.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

export async function createOrganization(db: Database, name: string): Promise<Organization> {
  const parsedName = z.string().trim().min(1).max(200).parse(name);
  const [row] = await db.insert(organizations).values({ name: parsedName }).returning();
  if (!row) throw new Error('Organization insert returned no row');
  return row;
}

export async function createWebsite(db: Database, input: NewWebsite): Promise<Website> {
  const values = newWebsiteSchema.parse(input);
  const [row] = await db.insert(websites).values(values).returning();
  if (!row) throw new Error('Website insert returned no row');
  return row;
}

export async function listWebsites(db: Database, organizationId: string): Promise<Website[]> {
  return db
    .select()
    .from(websites)
    .where(eq(websites.organizationId, organizationId))
    .orderBy(asc(websites.code));
}

export async function findWebsite(db: Database, websiteId: string): Promise<Website | undefined> {
  const parsed = z.uuid().safeParse(websiteId);
  if (!parsed.success) return undefined;
  const [row] = await db.select().from(websites).where(eq(websites.id, parsed.data)).limit(1);
  return row;
}

export async function findWebsiteByCode(db: Database, code: string): Promise<Website | undefined> {
  const [row] = await db.select().from(websites).where(eq(websites.code, code)).limit(1);
  return row;
}
