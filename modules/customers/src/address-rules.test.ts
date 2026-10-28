import { describe, expect, it } from 'vitest';
import {
  GST_STATE_CODES,
  gstinCheckCharacter,
  gstinProblem,
  isGstStateCode,
  isUsStateCode,
  isValidGstin,
  normalizePinCode,
  normalizeZipCode,
  US_STATE_CODES,
} from './index.js';

describe('PIN codes', () => {
  it.each([
    ['560001', '560001'],
    ['110001', '110001'],
    ['999999', '999999'],
    ['100000', '100000'],
    ['560 001', '560001'],
    ['  400051 ', '400051'],
    ['056001', undefined], // never starts with 0
    ['000000', undefined],
    ['56001', undefined], // five digits
    ['5600011', undefined], // seven digits
    ['5600 01', undefined], // space in the wrong place
    ['560  001', undefined], // two spaces
    ['560-001', undefined],
    ['56000A', undefined],
    ['', undefined],
    ['５６０００１', undefined], // full-width digits
  ])('%j gives %j', (input, expected) => {
    expect(normalizePinCode(input)).toBe(expected);
  });
});

describe('ZIP codes', () => {
  it.each([
    ['94105', '94105'],
    ['00501', '00501'], // leading zeros are real ZIP codes
    ['94105-1234', '94105-1234'],
    ['941051234', '94105-1234'],
    [' 10001 ', '10001'],
    ['9410', undefined],
    ['941055', undefined],
    ['94105-123', undefined],
    ['94105-12345', undefined],
    ['94105 1234', undefined],
    ['94105--1234', undefined],
    ['ABCDE', undefined],
    ['', undefined],
  ])('%j gives %j', (input, expected) => {
    expect(normalizeZipCode(input)).toBe(expected);
  });
});

describe('GST state codes', () => {
  it.each([
    ['01', true, 'Jammu and Kashmir'],
    ['07', true, 'Delhi'],
    ['24', true, 'Gujarat'],
    ['25', false, undefined], // merged into 26 in 2020
    ['26', true, 'Dadra and Nagar Haveli and Daman and Diu'],
    ['27', true, 'Maharashtra'],
    ['28', false, undefined], // Andhra Pradesh before 2014; GST uses 37
    ['29', true, 'Karnataka'],
    ['36', true, 'Telangana'],
    ['37', true, 'Andhra Pradesh'],
    ['38', true, 'Ladakh'],
    ['39', false, undefined],
    ['97', true, 'Other Territory'],
    ['99', false, undefined], // Centre Jurisdiction, not a place
    ['00', false, undefined],
    ['7', false, undefined],
    ['toString', false, undefined], // not fooled by object prototype keys
  ])('%j valid: %j', (code, valid, name) => {
    expect(isGstStateCode(code)).toBe(valid);
    if (isGstStateCode(code)) expect(GST_STATE_CODES[code]).toBe(name);
  });

  it('has 37 codes', () => {
    expect(Object.keys(GST_STATE_CODES)).toHaveLength(37);
  });
});

describe('US state codes', () => {
  it.each([
    ['CA', true],
    ['NY', true],
    ['DC', true],
    ['PR', true],
    ['GU', true],
    ['ca', false], // callers upper-case first
    ['XX', false],
    ['AA', false], // military codes are not accepted
    ['', false],
  ])('%j valid: %j', (code, valid) => {
    expect(isUsStateCode(code)).toBe(valid);
  });

  it('has the 50 states, DC and 5 territories', () => {
    expect(US_STATE_CODES).toHaveLength(56);
    expect(new Set(US_STATE_CODES).size).toBe(56);
  });
});

describe('GSTIN', () => {
  it.each([
    // Published GSTINs of real businesses.
    ['27AAPFU0939F1ZV', undefined],
    ['29AAGCB7383J1Z4', undefined],
    ['33AAACH7409R1Z8', undefined],
    ['24AAACC1206D1ZM', undefined],
    ['27AAACR5055K1Z7', undefined],
    // Constructed with the right check character, to cover edge state codes and entity numbers.
    ['01AAPFU0939F1Z9', undefined],
    ['37AAPFU0939F1ZU', undefined],
    ['38AAPFU0939F1ZS', undefined],
    ['97AAPFU0939F1ZO', undefined],
    ['27AAPFU0939FAZM', undefined], // entity number A: the eleventh registration in the state
    // Wrong check character: one typo anywhere changes it.
    ['27AAPFU0939F1ZW', 'check_character'],
    ['27AAPFU0939F1Z0', 'check_character'],
    ['27AAPFU0993F1ZV', 'check_character'], // two neighbouring digits swapped
    ['29AAPFU0939F1ZV', 'check_character'], // a different state with the same PAN
    // State codes that are well formed but not in use.
    ['25AAPFU0939F1ZZ', 'state_code'],
    ['28AAPFU0939F1ZT', 'state_code'],
    ['99AAPFU0939F1ZK', 'state_code'],
    // Format.
    ['27AAPFU0939F0ZW', 'format'], // entity number 0
    ['27AAPFU0939F1YV', 'format'], // fourteenth character must be Z
    ['27aapfu0939f1zv', 'format'], // callers upper-case first
    ['27AAPFU0939F1Z', 'format'], // 14 characters
    ['27AAPFU0939F1ZVV', 'format'], // 16 characters
    ['27AAPF10939F1ZV', 'format'], // PAN with a digit among the letters
    ['2AAAPFU0939F1ZV', 'format'],
    [' 27AAPFU0939F1ZV', 'format'],
    ['', 'format'],
  ])('%j has problem %j', (gstin, problem) => {
    expect(gstinProblem(gstin)).toBe(problem);
    expect(isValidGstin(gstin)).toBe(problem === undefined);
  });

  it.each([
    ['27AAPFU0939F1Z', 'V'],
    ['29AAGCB7383J1Z', '4'],
    ['33AAACH7409R1Z', '8'],
  ])('check character of %j is %j', (first14, expected) => {
    expect(gstinCheckCharacter(first14)).toBe(expected);
  });

  it('refuses characters outside 0-9 and A-Z when computing a check character', () => {
    expect(() => gstinCheckCharacter('27aapfu0939f1z')).toThrow(RangeError);
  });
});
