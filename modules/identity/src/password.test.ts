import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  normalizePassword,
  verifyPassword,
} from './password.js';
import { lockDurationMs } from './policy.js';
import { generateToken, hashToken, isWellFormedToken, normalizeEmail } from './tokens.js';

describe('checkPasswordPolicy', () => {
  it.each([
    ['short', 'Ab1!xyz', ['too_short']],
    ['exactly the minimum', 'correcthorse', []],
    ['long passphrase', 'correct horse battery staple', []],
    ['too long', 'a'.repeat(129), ['too_long']],
    ['common', 'Password1234', ['too_common']],
    ['common, any case', 'QWERTYUIOP123', ['too_common']],
  ])('%s', (_label, password, expected) => {
    expect(checkPasswordPolicy(password)).toEqual(expected);
  });

  it('rejects passwords that contain the email name', () => {
    expect(checkPasswordPolicy('ravi.kumar-2026!', 'ravi.kumar@example.com')).toEqual([
      'contains_email',
    ]);
    expect(checkPasswordPolicy('totally different words', 'ravi.kumar@example.com')).toEqual([]);
  });

  it('counts characters, not bytes, so Indic scripts and emoji are judged fairly', () => {
    // "नमस्ते" is 6 code points (18 bytes); twice is exactly the minimum of 12.
    expect(checkPasswordPolicy('नमस्तेनमस्ते')).toEqual([]);
    expect(checkPasswordPolicy('नमस्तेनमस्त')).toEqual(['too_short']);
    expect(checkPasswordPolicy('🔐'.repeat(12))).toEqual([]);
    expect(checkPasswordPolicy('🔐'.repeat(11))).toEqual(['too_short']);
  });

  it('imposes no composition rules', () => {
    expect(checkPasswordPolicy('alllowercaseletters')).toEqual([]);
  });
});

describe('password hashing', () => {
  it('produces argon2id hashes with the configured cost and verifies them', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(needsRehash(stored)).toBe(false);
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse battery stapler')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password twice')).not.toBe(
      await hashPassword('same password twice'),
    );
  });

  it('treats composed and decomposed Unicode as the same password', async () => {
    const composed = 'café-au-lait-2026';
    const decomposed = 'café-au-lait-2026';
    expect(normalizePassword(decomposed)).toBe(composed);
    expect(await verifyPassword(await hashPassword(composed), decomposed)).toBe(true);
  });

  it('fails closed on a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('flags weaker or foreign hashes for upgrade', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });
});

describe('lockDurationMs', () => {
  const minute = 60_000;
  it.each([
    [0, 0],
    [4, 0],
    [5, minute],
    [6, 2 * minute],
    [7, 4 * minute],
    [8, 8 * minute],
    [9, 15 * minute],
    [50, 15 * minute],
  ])('%d failures lock for %d ms', (failures, expected) => {
    expect(lockDurationMs(failures)).toBe(expected);
  });
});

describe('tokens', () => {
  it('generates 256-bit url-safe tokens that never repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(isWellFormedToken(token)).toBe(true);
  });

  it('rejects anything that is not a generated token', () => {
    for (const bad of ['', 'short', `${generateToken()}x`, "' or 1=1 --".padEnd(43, 'a')]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });

  it('stores tokens as SHA-256 hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('normalises emails without merging different mailboxes', () => {
    expect(normalizeEmail('  Ravi.Kumar+orders@Example.COM ')).toBe(
      'ravi.kumar+orders@example.com',
    );
  });
});
