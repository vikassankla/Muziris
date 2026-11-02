import { checkQuantity } from './format.js';

// Quick order (ADR 0018): rows pasted or read from a CSV in the browser, then checked against
// the products the API found. Nothing here is stored.

/** At most this many rows in one quick order, the most a shopping list holds. */
export const MAX_QUICK_ORDER_ROWS = 500;

/** productsBySkus answers at most this many SKUs per call. */
export const SKUS_PER_CALL = 100;

export interface QuickOrderRow {
  /** The line it came from, from 1, to point the buyer at it. */
  line: number;
  sku: string;
  quantity: string;
  /** Left out to mean the product's primary unit. */
  unitCode?: string;
}

export interface ParsedQuickOrder {
  rows: QuickOrderRow[];
  /** Lines that could not be read, with the reason. */
  problems: { line: number; message: string }[];
}

/** Splits one CSV line on commas, honouring double quotes ("a, b" and "" for a quote). */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/** A line's fields: split by a tab, a comma (CSV quoting allowed) or runs of spaces. */
function fieldsOf(line: string): string[] {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',')) return csvFields(line);
  return line.trim().split(/\s+/);
}

const HEADER = /^\s*"?sku"?\s*$/i;

/**
 * Reads pasted text or a CSV file: one item per line, SKU then quantity, with an optional unit
 * code third. Blank lines are skipped, and a first line whose first field is "SKU" is a header.
 * A line without a quantity counts as 1.
 */
export function parseQuickOrder(text: string): ParsedQuickOrder {
  const rows: QuickOrderRow[] = [];
  const problems: ParsedQuickOrder['problems'] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.trim() === '') continue;
    const [sku = '', quantity = '', unitCode = '', ...rest] = fieldsOf(raw).map((f) => f.trim());
    if (rows.length === 0 && problems.length === 0 && HEADER.test(sku)) continue;
    if (sku === '') {
      problems.push({ line, message: 'Start the line with a SKU.' });
    } else if (rest.some((f) => f !== '')) {
      problems.push({ line, message: 'Give a SKU, a quantity and an optional unit, no more.' });
    } else if (rows.length >= MAX_QUICK_ORDER_ROWS) {
      problems.push({
        line,
        message: `A quick order holds at most ${String(MAX_QUICK_ORDER_ROWS)} rows.`,
      });
      break;
    } else {
      rows.push({
        line,
        sku,
        quantity: quantity === '' ? '1' : quantity,
        ...(unitCode === '' ? {} : { unitCode: unitCode.toUpperCase() }),
      });
    }
  }
  return { rows, problems };
}

/** The SKUs to ask productsBySkus for, each once, in calls of at most SKUS_PER_CALL. */
export function skuBatches(rows: readonly QuickOrderRow[]): string[][] {
  const seen = new Set<string>();
  const skus: string[] = [];
  for (const row of rows) {
    const key = row.sku.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skus.push(row.sku);
  }
  const batches: string[][] = [];
  for (let i = 0; i < skus.length; i += SKUS_PER_CALL)
    batches.push(skus.slice(i, i + SKUS_PER_CALL));
  return batches;
}

export interface QuickOrderProduct {
  id: string;
  sku: string;
  name: string;
  /** The primary unit first. */
  units: readonly { code: string; name: string; precision: number }[];
  price: { unitPrice: { amount: string; currency: string } } | null;
}

export type CheckedRow =
  | {
      ok: true;
      row: QuickOrderRow;
      product: QuickOrderProduct;
      unit: QuickOrderProduct['units'][number];
      quantity: string;
    }
  | { ok: false; row: QuickOrderRow; product: QuickOrderProduct | undefined; message: string };

/**
 * Checks each row against the products found: known and orderable, sold in the unit, a
 * quantity at the unit's precision, and priced for the buyer. A hidden SKU reads as unknown.
 */
export function checkRows(
  rows: readonly QuickOrderRow[],
  products: readonly QuickOrderProduct[],
): CheckedRow[] {
  const bySku = new Map(products.map((p) => [p.sku.toUpperCase(), p]));
  return rows.map((row): CheckedRow => {
    const product = bySku.get(row.sku.toUpperCase());
    if (!product) {
      return {
        ok: false,
        row,
        product,
        message: 'We can’t find this SKU in your catalogue.',
      };
    }
    const unit =
      row.unitCode === undefined
        ? product.units[0]
        : product.units.find((u) => u.code === row.unitCode);
    if (!unit) {
      return {
        ok: false,
        row,
        product,
        message: `Not sold in ${row.unitCode ?? 'that unit'}. Units: ${product.units.map((u) => u.code).join(', ')}.`,
      };
    }
    const quantity = checkQuantity(row.quantity, unit);
    if (!quantity.ok) return { ok: false, row, product, message: quantity.message };
    if (!product.price) {
      return {
        ok: false,
        row,
        product,
        message: 'No price on your account. Ask your account manager for a quote.',
      };
    }
    return { ok: true, row, product, unit, quantity: quantity.quantity };
  });
}
