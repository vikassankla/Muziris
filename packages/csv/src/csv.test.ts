import { describe, expect, it } from 'vitest';
import { CsvError, csvCell, parseCsv, parseRecords, toCsv, unguardCell } from './index.js';

describe('parseRecords', () => {
  it('reads plain and quoted cells, line breaks inside quotes, and CRLF', () => {
    expect(parseRecords('﻿a, b ,c\r\n"x,1","say ""hi""","two\nlines"\n\n')).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'say "hi"', 'two\nlines'],
    ]);
  });

  it('keeps empty cells and a last line without a line end', () => {
    expect(parseRecords('a,,c\n1,2,')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('refuses unclosed quotes and text after a closing quote', () => {
    expect(() => parseRecords('"open,1')).toThrow(CsvError);
    expect(() => parseRecords('"a"b,1')).toThrow('Text after a closing quote');
    expect(() => parseRecords('a"b",1')).toThrow('A quote can only start a cell');
  });
});

describe('parseCsv', () => {
  const columns = ['sku', 'price'] as const;

  it('returns rows by column, with the header in any letter case', () => {
    expect(parseCsv('SKU,Price\nA-1,10\n', columns, { maxRows: 10 })).toEqual([
      { sku: 'A-1', price: '10' },
    ]);
  });

  it('refuses a wrong header, no rows, too many rows and a short row', () => {
    const code = (text: string) => {
      try {
        parseCsv(text, columns, { maxRows: 1 });
      } catch (error) {
        return error instanceof CsvError ? [error.code, error.row] : error;
      }
      return undefined;
    };
    expect(code('sku,amount\nA,1')).toEqual(['missing_header', undefined]);
    expect(code('sku,price\n')).toEqual(['no_rows', undefined]);
    expect(code('sku,price\nA,1\nB,2')).toEqual(['too_many_rows', undefined]);
    expect(code('sku,price\nA')).toEqual(['malformed', 1]);
  });
});

describe('toCsv', () => {
  it('guards formulas, quotes where needed, and round-trips', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('-x,"y"')).toBe('"\'-x,""y"""');
    const text = toCsv(['sku', 'name'], [['+1', 'Bolt, "M8"']]);
    expect(text).toBe('sku,name\r\n\'+1,"Bolt, ""M8"""\r\n');
    const [row] = parseCsv(text, ['sku', 'name'], { maxRows: 5 });
    expect(row && unguardCell(row.sku)).toBe('+1');
    expect(row?.name).toBe('Bolt, "M8"');
  });
});
