import { findProductsBySkus, type Product } from '@muziris/catalog';
import { CsvError, parseCsv, unguardCell } from '@muziris/csv';
import type { Database } from '@muziris/db';
import { decimalToString, type CurrencyCode } from '@muziris/money';
import { sql } from 'drizzle-orm';
import { recordChange } from './changes.js';
import { prices } from './db/schema.js';
import { PricingError } from './errors.js';
import { findPriceList } from './price-lists.js';
import { parseAmount, parseUnitQuantity } from './prices.js';

// Price imports from CSV (ADR 0022). Each row is checked as one price would be. By default one
// bad row refuses the file; with skipInvalid the good rows are written and the bad ones returned.
// A row adds or replaces the price for its product, unit and minimum quantity; nothing is deleted.

export const PRICE_CSV_COLUMNS = ['sku', 'unit', 'min_quantity', 'price'] as const;

/** At most this many rows in one import. The API also caps the body at 2 MB. */
export const MAX_PRICE_IMPORT_ROWS = 10_000;

export type ImportRowCode =
  'unknown_sku' | 'unit_not_sold' | 'invalid_quantity' | 'invalid_amount' | 'duplicate_row';

export interface ImportRowProblem {
  /** 1-based, counting rows after the header. */
  row: number;
  sku: string;
  code: ImportRowCode;
  message: string;
}

export interface PriceImportResult {
  added: number;
  updated: number;
  /** The rows left out; empty unless skipInvalid was asked for. */
  skipped: ImportRowProblem[];
}

/**
 * A file that was not imported: `invalid_file` when it is not the expected CSV, `invalid_rows`
 * when some rows are not valid prices (listed in `rows`) and skipInvalid was not asked for.
 */
export class PriceImportError extends Error {
  readonly code: 'invalid_file' | 'invalid_rows';
  readonly rows: readonly ImportRowProblem[];

  constructor(
    code: 'invalid_file' | 'invalid_rows',
    message: string,
    rows: readonly ImportRowProblem[] = [],
  ) {
    super(message);
    this.name = 'PriceImportError';
    this.code = code;
    this.rows = rows;
  }
}

interface ValidRow {
  productId: string;
  unitCode: string;
  minQuantity: string;
  amountMinor: bigint;
}

/** Rows are written this many at a time, to stay well inside the statement parameter limit. */
const CHUNK = 1000;

/** One row as a price, or why it is not one. Adds the row's key to `seen`. */
function checkRow(
  row: Record<(typeof PRICE_CSV_COLUMNS)[number], string>,
  product: Product | undefined,
  currency: CurrencyCode,
  seen: Set<string>,
): ValidRow | { code: ImportRowCode; message: string } {
  const message = (error: unknown) => (error instanceof Error ? error.message : 'Not valid');
  if (!product) return { code: 'unknown_sku', message: 'No product has this SKU' };
  const unit = product.units.find((u) => u.code === row.unit);
  if (!unit) return { code: 'unit_not_sold', message: `The product is not sold in "${row.unit}"` };
  let minQuantity: string;
  try {
    minQuantity = decimalToString(parseUnitQuantity(row.min_quantity || '1', unit));
  } catch (error) {
    return { code: 'invalid_quantity', message: message(error) };
  }
  let amountMinor: bigint;
  try {
    amountMinor = parseAmount(row.price, currency).minor;
  } catch (error) {
    return { code: 'invalid_amount', message: message(error) };
  }
  const key = `${product.id}|${unit.code}|${minQuantity}`;
  if (seen.has(key)) {
    return {
      code: 'duplicate_row',
      message: 'An earlier row has this SKU, unit and minimum quantity',
    };
  }
  seen.add(key);
  return { productId: product.id, unitCode: unit.code, minQuantity, amountMinor };
}

/** Imports a price list's prices from CSV in one transaction, counting one change for the build. */
export async function importPrices(
  db: Database,
  priceListId: string,
  csv: string,
  options: { skipInvalid?: boolean } = {},
): Promise<PriceImportResult> {
  const list = await findPriceList(db, priceListId);
  if (!list) throw new PricingError('price_list_not_found', 'No such price list');
  let rows: Record<(typeof PRICE_CSV_COLUMNS)[number], string>[];
  try {
    rows = parseCsv(csv, PRICE_CSV_COLUMNS, { maxRows: MAX_PRICE_IMPORT_ROWS });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    const where = error.row === undefined ? '' : ` (row ${String(error.row)})`;
    throw new PriceImportError('invalid_file', `${error.message}${where}`);
  }

  const skus = rows.map((r) => unguardCell(r.sku));
  const bySku = new Map<string, Product>(
    (await findProductsBySkus(db, skus)).map((p) => [p.sku.toLowerCase(), p]),
  );
  const problems: ImportRowProblem[] = [];
  const valid: ValidRow[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const sku = skus[index] ?? '';
    const checked = checkRow(row, bySku.get(sku.toLowerCase()), list.currency, seen);
    if ('code' in checked) problems.push({ row: index + 1, sku, ...checked });
    else valid.push(checked);
  }

  if (problems.length > 0 && options.skipInvalid !== true) {
    throw new PriceImportError(
      'invalid_rows',
      'Some rows are not valid; nothing was imported',
      problems,
    );
  }
  if (valid.length === 0) return { added: 0, updated: 0, skipped: problems };

  const { added, updated } = await db.transaction(async (tx) => {
    let added = 0;
    let updated = 0;
    for (let start = 0; start < valid.length; start += CHUNK) {
      const written = await tx
        .insert(prices)
        .values(valid.slice(start, start + CHUNK).map((v) => ({ ...v, priceListId: list.id })))
        .onConflictDoUpdate({
          target: [prices.priceListId, prices.productId, prices.unitCode, prices.minQuantity],
          set: { amountMinor: sql`excluded.amount_minor`, updatedAt: sql`now()` },
        })
        // A row the insert made has xmax 0; a row it updated does not.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      for (const w of written) {
        if (w.inserted) added += 1;
        else updated += 1;
      }
    }
    await recordChange(tx);
    return { added, updated };
  });
  return { added, updated, skipped: problems };
}
