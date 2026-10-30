import {
  allocate,
  compareDecimals,
  decimalToString,
  multiply,
  money,
  multiplyDecimals,
  parseDecimal,
  type Money,
} from '@muziris/money';
import type { TaxLine, TaxProblem, TaxRequest, TaxResult } from '@muziris/orders';

// The tax of ADR 0017, as pure functions over a request and the rows that apply to it, so every
// rule has a known-answer test without a database. provider.ts loads the rows.

export const TAX_PROVIDER_NAME = 'tax_tables';

export interface RegistrationRow {
  regime: 'gst' | 'us_sales_tax';
  regionCode: string;
  number: string;
}

export interface GstRateRow {
  codePrefix: string;
  /** A fraction as text, "0.18" or as the column returns it, "0.180000". */
  rate: string;
  validFrom: string;
  validTo: string | null;
}

export interface UsRateRow {
  stateCode: string;
  zipPrefix: string | null;
  rate: string;
  shippingTaxable: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface ExemptionRow {
  stateCode: string;
  certificateNumber: string;
  /** The last day it is valid, or null. */
  expiresOn: string | null;
}

/** The rows that may apply to one request: the website's registrations and candidate rates. */
export interface TaxData {
  registrations: readonly RegistrationRow[];
  gstRates: readonly GstRateRow[];
  usRates: readonly UsRateRow[];
  exemptions: readonly ExemptionRow[];
}

/**
 * Union territories without a legislature charge UTGST in place of SGST: Chandigarh (04), Dadra
 * and Nagar Haveli and Daman and Diu (26), Lakshadweep (31), Andaman and Nicobar Islands (35)
 * and Ladakh (38).
 */
export const UTGST_STATE_CODES: ReadonlySet<string> = new Set(['04', '26', '31', '35', '38']);

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Whether a dated row applies on a day: from its start, up to but not on its end. */
export function appliesOn(row: { validFrom: string; validTo: string | null }, day: string) {
  return row.validFrom <= day && (row.validTo === null || day < row.validTo);
}

/** A rate fraction without trailing zeros: "0.180000" is "0.18", "0.000000" is "0". */
export function rateText(rate: string): string {
  const text = decimalToString(parseDecimal(rate));
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

function halfOf(rate: string): string {
  return rateText(decimalToString(multiplyDecimals(parseDecimal(rate), parseDecimal('0.5'))));
}

function taxOn(amount: Money, rate: string): Money {
  return multiply(amount, rate, 'half-up');
}

/**
 * Each line's taxable value: its net less its share of order discounts, spread by net with no
 * minor unit lost. The pilot has no order discounts, so this is each line's net.
 */
function taxableValues(request: TaxRequest): Money[] {
  const nets = request.lines.map((l) => l.net);
  if (request.orderDiscount.minor === 0n) return nets;
  const shares = allocate(
    request.orderDiscount,
    nets.map((n) => Number(n.minor)),
  );
  return nets.map((net, i) => {
    const share = shares[i];
    if (!share) throw new Error('Allocation lost a line');
    return money(net.minor - share.minor, net.currency);
  });
}

function refused(problems: TaxProblem[]): TaxResult {
  return { lines: [], taxCodes: new Map(), problems };
}

/** The longest GST rate prefix that covers a code on a day. */
export function gstRateFor(
  code: string,
  rates: readonly GstRateRow[],
  day: string,
): GstRateRow | undefined {
  let best: GstRateRow | undefined;
  for (const row of rates) {
    if (!code.startsWith(row.codePrefix) || !appliesOn(row, day)) continue;
    if (!best || row.codePrefix.length > best.codePrefix.length) best = row;
  }
  return best;
}

/** India: CGST and SGST (or UTGST) within the seller's state, IGST across states. */
export function calculateGst(request: TaxRequest, data: TaxData, day: string): TaxResult {
  const registration = data.registrations.find((r) => r.regime === 'gst');
  if (!registration) {
    return refused([
      {
        lineNo: null,
        code: 'no_registration',
        message: 'The website has no GST registration (GSTIN)',
      },
    ]);
  }

  const problems: TaxProblem[] = [];
  const rates = new Map<number, string>();
  for (const line of request.lines) {
    if (line.hsnSacCode === null) {
      problems.push({
        lineNo: line.lineNo,
        code: 'no_tax_code',
        message: 'The product has no HSN or SAC code',
      });
      continue;
    }
    const row = gstRateFor(line.hsnSacCode, data.gstRates, day);
    if (!row) {
      problems.push({
        lineNo: line.lineNo,
        code: 'no_rate',
        message: `No GST rate covers ${line.hsnSacCode} on ${day}`,
      });
      continue;
    }
    rates.set(line.lineNo, rateText(row.rate));
  }
  if (problems.length > 0) return refused(problems);

  const intraState = request.shipTo.regionCode === registration.regionCode;
  const stateTax = UTGST_STATE_CODES.has(request.shipTo.regionCode) ? 'UTGST' : 'SGST';
  const taxesOn = (lineNo: number | null, taxable: Money, rate: string): TaxLine[] => {
    if (!intraState) {
      return [{ lineNo, name: 'IGST', rate, taxable, amount: taxOn(taxable, rate) }];
    }
    const half = halfOf(rate);
    return ['CGST', stateTax].map((name) => ({
      lineNo,
      name,
      rate: half,
      taxable,
      amount: taxOn(taxable, half),
    }));
  };

  const taxable = taxableValues(request);
  const lines: TaxLine[] = [];
  request.lines.forEach((line, i) => {
    const rate = rates.get(line.lineNo);
    const value = taxable[i];
    if (rate === undefined || !value) throw new Error(`Line ${line.lineNo} lost its rate`);
    lines.push(...taxesOn(line.lineNo, value, rate));
  });

  // Shipping is part of the supply, taxed at the highest rate among the lines (ADR 0017).
  if (request.shipping.minor > 0n) {
    let highest = '0';
    for (const rate of rates.values()) {
      if (compareDecimals(parseDecimal(rate), parseDecimal(highest)) > 0) highest = rate;
    }
    lines.push(...taxesOn(null, request.shipping, highest));
  }

  return {
    lines,
    taxCodes: new Map(
      request.lines.flatMap((l) => (l.hsnSacCode === null ? [] : [[l.lineNo, l.hsnSacCode]])),
    ),
    sellerTaxId: registration.number,
  };
}

/** The first five digits of a ZIP or ZIP+4 code. */
function zip5(postalCode: string): string {
  return postalCode.replace(/\D/g, '').slice(0, 5);
}

/** The US rate with the longest ZIP prefix covering the ZIP code on a day, then the state's. */
export function usRateFor(
  stateCode: string,
  postalCode: string,
  rates: readonly UsRateRow[],
  day: string,
): UsRateRow | undefined {
  const zip = zip5(postalCode);
  let best: UsRateRow | undefined;
  for (const row of rates) {
    if (row.stateCode !== stateCode || !appliesOn(row, day)) continue;
    if (row.zipPrefix !== null && !zip.startsWith(row.zipPrefix)) continue;
    if (!best || (row.zipPrefix?.length ?? 0) > (best.zipPrefix?.length ?? 0)) best = row;
  }
  return best;
}

/** US: destination sales tax, only in states where the seller holds a permit. */
export function calculateUs(request: TaxRequest, data: TaxData, day: string): TaxResult {
  const state = request.shipTo.regionCode;
  const taxCodes = new Map(request.lines.map((l) => [l.lineNo, l.usTaxCategory ?? 'general']));
  const registration = data.registrations.find(
    (r) => r.regime === 'us_sales_tax' && r.regionCode === state,
  );
  // No permit in the ship-to state: the seller does not collect there.
  if (!registration) return { lines: [], taxCodes, sellerTaxId: null };

  const exemption = data.exemptions.find(
    (e) => e.stateCode === state && (e.expiresOn === null || day <= e.expiresOn),
  );
  if (exemption) {
    return {
      lines: [],
      taxCodes,
      sellerTaxId: registration.number,
      exemptionCertificate: exemption.certificateNumber,
    };
  }

  const row = usRateFor(state, request.shipTo.postalCode, data.usRates, day);
  if (!row) {
    return refused([
      {
        lineNo: null,
        code: 'no_rate',
        message: `No sales tax rate for ${state} ${zip5(request.shipTo.postalCode)} on ${day}`,
      },
    ]);
  }
  const rate = rateText(row.rate);
  const name = `${state} sales tax`;

  const taxable = taxableValues(request);
  const lines: TaxLine[] = [];
  request.lines.forEach((line, i) => {
    const value = taxable[i];
    if (!value) throw new Error(`Line ${line.lineNo} lost its taxable value`);
    if (line.usTaxCategory === 'exempt') return;
    lines.push({ lineNo: line.lineNo, name, rate, taxable: value, amount: taxOn(value, rate) });
  });
  // Shipping is taxed where the rate says so, and only with something taxable in the order.
  if (row.shippingTaxable && request.shipping.minor > 0n && lines.length > 0) {
    lines.push({
      lineNo: null,
      name,
      rate,
      taxable: request.shipping,
      amount: taxOn(request.shipping, rate),
    });
  }
  return { lines, taxCodes, sellerTaxId: registration.number };
}

/** Tax for a request with the rows that may apply, by the website's country. */
export function calculateTax(request: TaxRequest, data: TaxData): TaxResult {
  if (request.shipTo.countryCode !== request.websiteCountryCode) {
    return refused([
      {
        lineNo: null,
        code: 'cross_border',
        message: 'Orders shipped to another country are not taken yet',
      },
    ]);
  }
  const day = localDay(request.now, request.websiteTimeZone);
  switch (request.websiteCountryCode) {
    case 'IN':
      return calculateGst(request, data, day);
    case 'US':
      return calculateUs(request, data, day);
    default:
      return refused([
        {
          lineNo: null,
          code: 'no_registration',
          message: `Tax for websites in ${request.websiteCountryCode} is not supported yet`,
        },
      ]);
  }
}
