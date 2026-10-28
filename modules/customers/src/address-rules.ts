// Postal and tax identifier rules for India and the US. Pure functions, no database.

/**
 * GST state codes a business address can have, from the GST portal's state code list.
 * Not included: 25 (Daman and Diu, merged into 26 in 2020), 28 (Andhra Pradesh before 2014;
 * GST registrations there use 37) and 99 (Centre Jurisdiction, not a place).
 */
export const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
} as const;

export type GstStateCode = keyof typeof GST_STATE_CODES;

/** USPS codes for the 50 states, the District of Columbia and the inhabited territories. */
export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'AS', 'GU', 'MP', 'PR', 'VI',
] as const; // prettier-ignore

export type UsStateCode = (typeof US_STATE_CODES)[number];

export function isGstStateCode(value: string): value is GstStateCode {
  return Object.hasOwn(GST_STATE_CODES, value);
}

export function isUsStateCode(value: string): value is UsStateCode {
  return (US_STATE_CODES as readonly string[]).includes(value);
}

/**
 * Returns the six-digit PIN code, or undefined if the input is not one. Accepts the common
 * written form with a space after the third digit ("560 001"). PIN codes never start with 0.
 */
export function normalizePinCode(input: string): string | undefined {
  const match = /^([1-9]\d{2}) ?(\d{3})$/.exec(input.trim());
  return match ? `${match[1] ?? ''}${match[2] ?? ''}` : undefined;
}

/**
 * Returns a five-digit ZIP code or ZIP+4 ("12345-6789"), or undefined if the input is not one.
 * Nine digits without the hyphen are accepted and given one.
 */
export function normalizeZipCode(input: string): string | undefined {
  const match = /^(\d{5})(?:-?(\d{4}))?$/.exec(input.trim());
  if (!match) return undefined;
  const [, zip, plusFour] = match;
  return plusFour === undefined ? zip : `${zip ?? ''}-${plusFour}`;
}

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A regular taxpayer's GSTIN: state code, PAN (five letters, four digits, a letter), entity
 * number, the letter Z, and a check character. Other registration types (TDS deductors, UN
 * bodies, non-resident taxpayers) use different formats and are not accepted here.
 */
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * The check character for the first 14 characters of a GSTIN (Luhn mod 36): weights alternate
 * 1 and 2 from the left, and each product contributes its base-36 digits.
 */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_ALPHABET.indexOf(first14.charAt(i));
    if (value < 0) throw new RangeError('GSTIN characters must be digits or capital letters');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = 'format' | 'state_code' | 'check_character';

/** Checks a GSTIN (already trimmed and upper-cased). Returns the first problem, or undefined. */
export function gstinProblem(gstin: string): GstinProblem | undefined {
  if (!GSTIN_PATTERN.test(gstin)) return 'format';
  if (!isGstStateCode(gstin.slice(0, 2))) return 'state_code';
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'check_character';
  return undefined;
}

export function isValidGstin(gstin: string): boolean {
  return gstinProblem(gstin) === undefined;
}
