import { hash, verify } from '@node-rs/argon2';
import { COMMON_PASSWORDS } from './common-passwords.js';

/**
 * The library's Algorithm.Argon2id. It ships as a const enum, which isolated-module builds
 * cannot import, so the value is written out; a test asserts the hashes really are argon2id.
 */
const ARGON2ID = 2;

/**
 * Argon2id with the OWASP Password Storage Cheat Sheet baseline: 19 MiB memory, 2 iterations,
 * 1 lane. Raising these later is safe: stored hashes are upgraded on the next sign-in.
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'contains_email';

/**
 * Normalises to NFKC so the same password typed on different keyboards or devices produces
 * the same bytes. Applied before both hashing and verifying.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Checks a new password against the policy (OWASP ASVS 5.0 chapter 6, NIST SP 800-63B):
 * a length range, no composition rules, and rejection of common or account-derived passwords.
 * Length counts characters (code points), so emoji and Indic scripts are not penalised.
 */
/**
 * Counts Unicode code points, as NIST SP 800-63B specifies for password length. Deliberately
 * not grapheme clusters: a Devanagari conjunct is several keystrokes and counts as several.
 */
function countCodePoints(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // A high surrogate followed by a low surrogate is one code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

export function checkPasswordPolicy(password: string, email?: string): PasswordProblem[] {
  const normalized = normalizePassword(password);
  const length = countCodePoints(normalized);
  const problems: PasswordProblem[] = [];
  if (length < PASSWORD_MIN_LENGTH) problems.push('too_short');
  if (length > PASSWORD_MAX_LENGTH) problems.push('too_long');
  const lowered = normalized.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) problems.push('too_common');
  const localPart = email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lowered.includes(localPart)) {
    problems.push('contains_email');
  }
  return problems;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(normalizePassword(password), ARGON2_PARAMS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, normalizePassword(password));
  } catch {
    // A malformed stored hash must fail closed, never throw through to the caller.
    return false;
  }
}

/** True when a stored hash uses weaker settings than ARGON2_PARAMS and should be replaced. */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, memory, time, lanes] = match.map(Number);
  return (
    memory !== ARGON2_PARAMS.memoryCost ||
    time !== ARGON2_PARAMS.timeCost ||
    lanes !== ARGON2_PARAMS.parallelism
  );
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a verification against a throwaway hash. Called when the email is unknown, so a failed
 * sign-in takes the same time whether or not the account exists.
 */
export async function burnVerifyTime(password: string): Promise<void> {
  dummyHash ??= hash('muziris-timing-equaliser', ARGON2_PARAMS);
  await verifyPassword(await dummyHash, password);
}
