import { isUsStateCode } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { decimalToString, parseDecimal } from '@muziris/money';
import { and, asc, eq, gt, isNull, ne, or, sql, type Column, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { rateText } from './calculate.js';
import { gstRates, usRates } from './db/schema.js';
import { TaxError } from './errors.js';

// GST and US sales tax rates (ADR 0017). Admins enter them as percentages with dates; they are
// stored as fractions. At most one rate applies to a code, or a state and ZIP prefix, on any day,
// and each row records the admin who entered and last changed it.

export interface GstRate {
  id: string;
  codePrefix: string;
  /** A fraction: "0.18". */
  rate: string;
  /** The same as a percentage: "18". */
  ratePercent: string;
  validFrom: string;
  validTo: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsRate extends Omit<GstRate, 'codePrefix'> {
  stateCode: string;
  zipPrefix: string | null;
  shippingTaxable: boolean;
}

const daySchema = z.iso.date();

/** A percentage below 100 with at most four decimals ("18", "7.25", "0.1"), as a fraction. */
const percentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,2}(\.\d{1,4})?$/, 'Use a percentage below 100 with at most four decimals')
  .transform((percent) => {
    const d = parseDecimal(percent);
    return rateText(decimalToString({ units: d.units, scale: d.scale + 2 }));
  });

function percentOf(rate: string): string {
  const d = parseDecimal(rate);
  // Two places to the left: the fraction 0.0725 is 7.25 percent.
  const scaled = { units: d.units * 100n, scale: d.scale };
  return rateText(decimalToString(scaled));
}

const period = {
  validFrom: daySchema,
  validTo: daySchema.nullable().default(null),
};

function checkPeriod(value: { validFrom: string; validTo: string | null }, ctx: z.RefinementCtx) {
  if (value.validTo !== null && value.validTo <= value.validFrom) {
    ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'End after the start' });
  }
}

export const newGstRateSchema = z
  .object({
    codePrefix: z
      .string()
      .trim()
      .regex(/^(\d{2}){1,4}$/, 'Use 2, 4, 6 or 8 digits of an HSN or SAC code'),
    ratePercent: percentSchema,
    ...period,
  })
  .superRefine(checkPeriod);

export const newUsRateSchema = z
  .object({
    stateCode: z.string().trim().toUpperCase().refine(isUsStateCode, 'Not a US state code'),
    zipPrefix: z
      .string()
      .trim()
      .regex(/^\d{1,5}$/, 'Use 1 to 5 digits of a ZIP code')
      .nullable()
      .default(null),
    ratePercent: percentSchema,
    shippingTaxable: z.boolean(),
    ...period,
  })
  .superRefine(checkPeriod);

/** The end date is the only change: a rate's value is never edited, a new rate follows it. */
export const rateEndSchema = z.object({ validTo: daySchema.nullable() });

export const listRatesQuerySchema = z.object({
  /** Only rates that apply on this day. */
  on: daySchema.optional(),
});

function gstRate(row: typeof gstRates.$inferSelect): GstRate {
  const rate = rateText(row.rate);
  return { ...row, rate, ratePercent: percentOf(rate) };
}

function usRate(row: typeof usRates.$inferSelect): UsRate {
  const rate = rateText(row.rate);
  return { ...row, rate, ratePercent: percentOf(rate) };
}

/** Rows whose period overlaps [from, to), where null is no end. */
function overlapping(
  columns: { validFrom: Column; validTo: Column },
  from: string,
  to: string | null,
): SQL {
  const endsAfterStart = sql`(${columns.validTo} is null or ${columns.validTo} > ${from})`;
  return to === null ? endsAfterStart : sql`${endsAfterStart} and ${columns.validFrom} < ${to}`;
}

/** Serialises rate changes for one key, so two admins cannot enter overlapping periods. */
async function lockKey(tx: Pick<Database, 'execute'>, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function addGstRate(
  db: Database,
  adminUserId: string,
  input: z.input<typeof newGstRateSchema>,
): Promise<GstRate> {
  const values = newGstRateSchema.parse(input);
  const actor = z.uuid().parse(adminUserId);
  return db.transaction(async (tx) => {
    await lockKey(tx, `tax_gst_rate:${values.codePrefix}`);
    const clash = await tx
      .select({ id: gstRates.id })
      .from(gstRates)
      .where(
        and(
          eq(gstRates.codePrefix, values.codePrefix),
          overlapping(gstRates, values.validFrom, values.validTo),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw new TaxError(
        'rate_overlaps',
        `Another rate for ${values.codePrefix} applies on some of these days; end it first`,
      );
    }
    const [row] = await tx
      .insert(gstRates)
      .values({
        codePrefix: values.codePrefix,
        rate: values.ratePercent,
        validFrom: values.validFrom,
        validTo: values.validTo,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    if (!row) throw new Error('Rate insert returned no row');
    return gstRate(row);
  });
}

function usKey(stateCode: string, zipPrefix: string | null) {
  return `tax_us_rate:${stateCode}:${zipPrefix ?? ''}`;
}

function sameUsKey(stateCode: string, zipPrefix: string | null): SQL {
  return (
    and(
      eq(usRates.stateCode, stateCode),
      zipPrefix === null ? isNull(usRates.zipPrefix) : eq(usRates.zipPrefix, zipPrefix),
    ) ?? sql`false`
  );
}

type UsRateValues = z.output<typeof newUsRateSchema>;

async function insertUsRate(
  tx: Pick<Database, 'select' | 'insert' | 'execute'>,
  actor: string,
  values: UsRateValues,
) {
  await lockKey(tx, usKey(values.stateCode, values.zipPrefix));
  const clash = await tx
    .select({ id: usRates.id })
    .from(usRates)
    .where(
      and(
        sameUsKey(values.stateCode, values.zipPrefix),
        overlapping(usRates, values.validFrom, values.validTo),
      ),
    )
    .limit(1);
  if (clash.length > 0) {
    const where =
      values.zipPrefix === null ? values.stateCode : `${values.stateCode} ${values.zipPrefix}`;
    throw new TaxError(
      'rate_overlaps',
      `Another rate for ${where} applies on some of these days; end it first`,
    );
  }
  const [row] = await tx
    .insert(usRates)
    .values({
      stateCode: values.stateCode,
      zipPrefix: values.zipPrefix,
      rate: values.ratePercent,
      shippingTaxable: values.shippingTaxable,
      validFrom: values.validFrom,
      validTo: values.validTo,
      createdBy: actor,
      updatedBy: actor,
    })
    .returning();
  if (!row) throw new Error('Rate insert returned no row');
  return usRate(row);
}

export async function addUsRate(
  db: Database,
  adminUserId: string,
  input: z.input<typeof newUsRateSchema>,
): Promise<UsRate> {
  const values = newUsRateSchema.parse(input);
  const actor = z.uuid().parse(adminUserId);
  return db.transaction((tx) => insertUsRate(tx, actor, values));
}

/** Changes when a GST rate ends, for example to make way for a new one. */
export async function endGstRate(
  db: Database,
  adminUserId: string,
  rateId: string,
  input: z.input<typeof rateEndSchema>,
): Promise<GstRate> {
  const { validTo } = rateEndSchema.parse(input);
  const actor = z.uuid().parse(adminUserId);
  const id = z.uuid().safeParse(rateId);
  if (!id.success) throw new TaxError('rate_not_found', 'No such rate');
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(gstRates).where(eq(gstRates.id, id.data));
    if (!current) throw new TaxError('rate_not_found', 'No such rate');
    await lockKey(tx, `tax_gst_rate:${current.codePrefix}`);
    if (validTo !== null && validTo <= current.validFrom) {
      throw new TaxError('rate_overlaps', 'A rate must end after it starts');
    }
    const clash = await tx
      .select({ id: gstRates.id })
      .from(gstRates)
      .where(
        and(
          eq(gstRates.codePrefix, current.codePrefix),
          ne(gstRates.id, current.id),
          overlapping(gstRates, current.validFrom, validTo),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw new TaxError('rate_overlaps', 'Another rate starts before this one would end');
    }
    const [row] = await tx
      .update(gstRates)
      .set({ validTo, updatedBy: actor, updatedAt: new Date() })
      .where(eq(gstRates.id, current.id))
      .returning();
    if (!row) throw new TaxError('rate_not_found', 'No such rate');
    return gstRate(row);
  });
}

/** Changes when a US rate ends. */
export async function endUsRate(
  db: Database,
  adminUserId: string,
  rateId: string,
  input: z.input<typeof rateEndSchema>,
): Promise<UsRate> {
  const { validTo } = rateEndSchema.parse(input);
  const actor = z.uuid().parse(adminUserId);
  const id = z.uuid().safeParse(rateId);
  if (!id.success) throw new TaxError('rate_not_found', 'No such rate');
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(usRates).where(eq(usRates.id, id.data));
    if (!current) throw new TaxError('rate_not_found', 'No such rate');
    await lockKey(tx, usKey(current.stateCode, current.zipPrefix));
    if (validTo !== null && validTo <= current.validFrom) {
      throw new TaxError('rate_overlaps', 'A rate must end after it starts');
    }
    const clash = await tx
      .select({ id: usRates.id })
      .from(usRates)
      .where(
        and(
          sameUsKey(current.stateCode, current.zipPrefix),
          ne(usRates.id, current.id),
          overlapping(usRates, current.validFrom, validTo),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw new TaxError('rate_overlaps', 'Another rate starts before this one would end');
    }
    const [row] = await tx
      .update(usRates)
      .set({ validTo, updatedBy: actor, updatedAt: new Date() })
      .where(eq(usRates.id, current.id))
      .returning();
    if (!row) throw new TaxError('rate_not_found', 'No such rate');
    return usRate(row);
  });
}

function onDay(columns: typeof gstRates | typeof usRates, day: string | undefined): SQL {
  if (day === undefined) return sql`true`;
  return (
    and(
      sql`${columns.validFrom} <= ${day}`,
      or(isNull(columns.validTo), gt(columns.validTo, day)),
    ) ?? sql`false`
  );
}

export async function listGstRates(
  db: Pick<Database, 'select'>,
  query: z.input<typeof listRatesQuerySchema> & { codePrefix?: string } = {},
): Promise<GstRate[]> {
  const { on } = listRatesQuerySchema.parse({ on: query.on });
  const rows = await db
    .select()
    .from(gstRates)
    .where(
      and(
        onDay(gstRates, on),
        query.codePrefix === undefined ? undefined : eq(gstRates.codePrefix, query.codePrefix),
      ),
    )
    .orderBy(asc(gstRates.codePrefix), asc(gstRates.validFrom));
  return rows.map(gstRate);
}

export async function listUsRates(
  db: Pick<Database, 'select'>,
  query: z.input<typeof listRatesQuerySchema> & { stateCode?: string } = {},
): Promise<UsRate[]> {
  const { on } = listRatesQuerySchema.parse({ on: query.on });
  const rows = await db
    .select()
    .from(usRates)
    .where(
      and(
        onDay(usRates, on),
        query.stateCode === undefined ? undefined : eq(usRates.stateCode, query.stateCode),
      ),
    )
    .orderBy(asc(usRates.stateCode), asc(usRates.zipPrefix), asc(usRates.validFrom));
  return rows.map(usRate);
}

export async function deleteGstRate(db: Database, rateId: string): Promise<void> {
  const id = z.uuid().safeParse(rateId);
  const deleted = id.success
    ? await db.delete(gstRates).where(eq(gstRates.id, id.data)).returning({ id: gstRates.id })
    : [];
  if (deleted.length === 0) throw new TaxError('rate_not_found', 'No such rate');
}

export async function deleteUsRate(db: Database, rateId: string): Promise<void> {
  const id = z.uuid().safeParse(rateId);
  const deleted = id.success
    ? await db.delete(usRates).where(eq(usRates.id, id.data)).returning({ id: usRates.id })
    : [];
  if (deleted.length === 0) throw new TaxError('rate_not_found', 'No such rate');
}

export const US_RATES_CSV_HEADER = [
  'state',
  'zip_prefix',
  'rate_percent',
  'shipping_taxable',
  'valid_from',
  'valid_to',
] as const;

/** At most this many rows in one import. */
export const MAX_IMPORT_ROWS = 5_000;

/**
 * Reads a US rates CSV: a header row of US_RATES_CSV_HEADER, then one rate per row. Plain
 * comma-separated values, no quoting. `zip_prefix` and `valid_to` may be empty; `shipping_taxable`
 * is true or false. Every row is checked, and any refused row refuses the whole file.
 */
export function parseUsRatesCsv(text: string): UsRateValues[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const [header, ...body] = lines;
  if (header?.toLowerCase().replace(/\s/g, '') !== US_RATES_CSV_HEADER.join(',')) {
    throw new TaxError(
      'invalid_import',
      `The first row must be the header ${US_RATES_CSV_HEADER.join(',')}`,
    );
  }
  if (body.length === 0) throw new TaxError('invalid_import', 'The file has no rates');
  if (body.length > MAX_IMPORT_ROWS) {
    throw new TaxError('invalid_import', `Import at most ${MAX_IMPORT_ROWS} rates at a time`);
  }
  const problems: { row: number; message: string }[] = [];
  const values: UsRateValues[] = [];
  body.forEach((line, index) => {
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== US_RATES_CSV_HEADER.length) {
      problems.push({ row: index + 1, message: `Expected ${US_RATES_CSV_HEADER.length} values` });
      return;
    }
    const [state, zipPrefix, ratePercent, shipping, validFrom, validTo] = cells;
    const shippingTaxable =
      shipping === 'true' ? true : shipping === 'false' ? false : (shipping ?? '');
    const parsed = newUsRateSchema.safeParse({
      stateCode: state,
      zipPrefix: zipPrefix === '' ? null : zipPrefix,
      ratePercent,
      shippingTaxable,
      validFrom,
      validTo: validTo === '' ? null : validTo,
    });
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      problems.push({
        row: index + 1,
        message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Not a valid rate',
      });
      return;
    }
    values.push(parsed.data);
  });
  if (problems.length > 0) {
    throw new TaxError('invalid_import', 'Some rows are not valid; nothing was imported', problems);
  }
  return values;
}

/** Imports a US rates CSV in one transaction: every rate, or none. */
export async function importUsRates(
  db: Database,
  adminUserId: string,
  csv: string,
): Promise<{ imported: number }> {
  const actor = z.uuid().parse(adminUserId);
  const rows = parseUsRatesCsv(csv);
  await db.transaction(async (tx) => {
    for (const [index, values] of rows.entries()) {
      try {
        await insertUsRate(tx, actor, values);
      } catch (error) {
        if (error instanceof TaxError) {
          throw new TaxError('invalid_import', 'A row clashes; nothing was imported', [
            { row: index + 1, message: error.message },
          ]);
        }
        throw error;
      }
    }
  });
  return { imported: rows.length };
}
