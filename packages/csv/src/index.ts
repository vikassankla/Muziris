// CSV for imports and exports (ADR 0022): comma-separated, UTF-8, RFC 4180 quoting. Shared by
// the price list and US tax rate imports so there is one parser to get right.

export type CsvErrorCode = 'missing_header' | 'no_rows' | 'too_many_rows' | 'malformed';

/** A file that cannot be read as the expected CSV; `row` is 1-based, after the header. */
export class CsvError extends Error {
  readonly code: CsvErrorCode;
  readonly row: number | undefined;

  constructor(code: CsvErrorCode, message: string, row?: number) {
    super(message);
    this.name = 'CsvError';
    this.code = code;
    this.row = row;
  }
}

/**
 * Splits CSV text into records of cells. Quoted cells may hold commas, quotes ("") and line
 * breaks. A byte order mark is dropped, and blank lines are skipped.
 */
export function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const input = text.replace(/^\uFEFF/, '');
  const endRecord = () => {
    record.push(wasQuoted ? cell : cell.trim());
    if (record.length > 1 || record[0] !== '' || wasQuoted) records.push(record);
    record = [];
    cell = '';
    wasQuoted = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input.charAt(i);
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      if (cell.trim() !== '') {
        throw new CsvError('malformed', 'A quote can only start a cell', records.length);
      }
      cell = '';
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') {
      record.push(wasQuoted ? cell : cell.trim());
      cell = '';
      wasQuoted = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      endRecord();
    } else if (wasQuoted) {
      if (char !== ' ' && char !== '\t') {
        throw new CsvError('malformed', 'Text after a closing quote', records.length);
      }
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CsvError('malformed', 'A quoted cell is not closed', records.length);
  if (cell !== '' || record.length > 0 || wasQuoted) endRecord();
  return records;
}

/**
 * Reads a CSV whose first row is exactly `columns` (any letter case), then one record per row
 * with that many cells. Returns the rows as objects by column name.
 */
export function parseCsv<C extends string>(
  text: string,
  columns: readonly C[],
  options: { maxRows: number },
): Record<C, string>[] {
  const [header, ...body] = parseRecords(text);
  const names = header?.map((h) => h.toLowerCase());
  if (names?.join(',') !== columns.join(',')) {
    throw new CsvError('missing_header', `The first row must be the header ${columns.join(',')}`);
  }
  if (body.length === 0) throw new CsvError('no_rows', 'The file has no rows after the header');
  if (body.length > options.maxRows) {
    throw new CsvError('too_many_rows', `Import at most ${String(options.maxRows)} rows at a time`);
  }
  return body.map((cells, index) => {
    if (cells.length !== columns.length) {
      throw new CsvError(
        'malformed',
        `Expected ${String(columns.length)} values, found ${String(cells.length)}`,
        index + 1,
      );
    }
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])) as Record<C, string>;
  });
}

/**
 * One cell, safe to open in a spreadsheet: a value starting with =, +, -, @, a tab or a
 * carriage return gets a leading ' so it is not run as a formula, and a value holding a comma,
 * quote or line break is quoted.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV file: the header, then each row, with CRLF line ends as RFC 4180 has them. */
export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Undoes csvCell's formula guard, so an exported file imports again unchanged. */
export function unguardCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
