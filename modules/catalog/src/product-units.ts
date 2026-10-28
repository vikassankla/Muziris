import type { Database } from '@muziris/db';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { productUnits } from './db/schema.js';
import { CatalogError, isUniqueViolation } from './errors.js';
import { MAX_UNIT_PRECISION } from './quantity.js';

/** A unit products are sold in (each, box of 10, kg) with its decimal precision. */
export interface ProductUnit {
  code: string;
  name: string;
  /** Digits allowed after the decimal point in a quantity of this unit. */
  precision: number;
}

export const newProductUnitSchema = z.object({
  code: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,31}$/,
      'Use 1 to 32 lowercase letters, digits or _, starting with a letter',
    ),
  name: z.string().trim().min(1).max(100),
  precision: z.int().min(0).max(MAX_UNIT_PRECISION),
});

export type NewProductUnit = z.input<typeof newProductUnitSchema>;

export const productUnitCodeSchema = newProductUnitSchema.shape.code;

function toProductUnit(row: typeof productUnits.$inferSelect): ProductUnit {
  return { code: row.code, name: row.name, precision: row.precision };
}

export async function createProductUnit(db: Database, input: NewProductUnit): Promise<ProductUnit> {
  const values = newProductUnitSchema.parse(input);
  try {
    const [row] = await db.insert(productUnits).values(values).returning();
    if (!row) throw new Error('Product unit insert returned no row');
    return toProductUnit(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogError('product_unit_code_taken', 'That product unit code is taken');
    }
    throw error;
  }
}

export async function listProductUnits(db: Database): Promise<ProductUnit[]> {
  const rows = await db.select().from(productUnits).orderBy(asc(productUnits.code));
  return rows.map(toProductUnit);
}

export async function findProductUnit(
  db: Database,
  code: string,
): Promise<ProductUnit | undefined> {
  const parsed = productUnitCodeSchema.safeParse(code);
  if (!parsed.success) return undefined;
  const [row] = await db
    .select()
    .from(productUnits)
    .where(eq(productUnits.code, parsed.data))
    .limit(1);
  return row ? toProductUnit(row) : undefined;
}
