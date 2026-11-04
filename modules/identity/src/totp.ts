import { hashRaw } from '@node-rs/argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { ARGON2_PARAMS } from './password.js';

// Time-based one-time codes for admin sign-in (ADR 0026): HOTP (RFC 4226) over a 30-second
// step (RFC 6238), SHA-1 and 6 digits, which every authenticator app reads. Built on
// node:crypto alone; the RFCs' test vectors are the known-answer tests.

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Steps either side of now that are also accepted, for a phone whose clock drifts. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, as RFC 4226 recommends. */
const SECRET_BYTES = 20;

/** The HOTP value of a secret at a counter (RFC 4226 section 5), as a zero-padded string. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment falls in. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code an authenticator app shows for a secret at a moment. */
export function totpCode(secret: Buffer, now: Date, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(now), digits);
}

/**
 * The step a code matches, now or one step either side, or undefined. Every candidate is
 * compared in constant time, so the answer's timing does not say which step matched.
 */
export function matchTotp(secret: Buffer, code: string, now: Date): number | undefined {
  const given = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return undefined;
  const current = totpStep(now);
  let matched: number | undefined;
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step++) {
    const expected = hotp(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given)) && matched === undefined) {
      matched = step;
    }
  }
  return matched;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the form authenticator apps take a secret in. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The otpauth:// link a QR code carries (the Key Uri Format authenticator apps read). */
export function totpUri(secret: Buffer, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Secrets at rest: AES-256-GCM under ADMIN_TOTP_KEY, with the user id as associated data so a
// secret copied onto another user's row does not decrypt.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 'v1';

/** The key that encrypts the secrets, from ADMIN_TOTP_KEY: 32 bytes in base64. */
export interface TotpKey {
  readonly bytes: Buffer;
}

export class TotpKeyError extends Error {
  constructor() {
    super('ADMIN_TOTP_KEY must be 32 bytes in base64');
    this.name = 'TotpKeyError';
  }
}

/** Reads ADMIN_TOTP_KEY. The error never quotes the value. */
export function parseTotpKey(base64: string): TotpKey {
  const trimmed = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new TotpKeyError();
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== KEY_BYTES) throw new TotpKeyError();
  return { bytes };
}

export function encryptSecret(key: TotpKey, userId: string, secret: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

/** Throws when the key is wrong, the user id differs or the stored text was changed. */
export function decryptSecret(key: TotpKey, userId: string, stored: string): Buffer {
  const [format, payload] = stored.split(':');
  if (format !== FORMAT || payload === undefined) throw new Error('Unknown secret format');
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// Recovery codes: 10 characters from an alphabet with no look-alikes (no 0/O, 1/I/L), shown
// as two groups of five. Only their Argon2id hashes are stored, under one salt per set.

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 10;

export function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    code += RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length));
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Spaces, dashes and case do not matter when a recovery code is typed. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase().slice(0, 64);
}

const RECOVERY_SALT_BYTES = 16;

/** A new salt for a set of recovery codes, in base64. */
export function generateRecoverySalt(): string {
  return randomBytes(RECOVERY_SALT_BYTES).toString('base64');
}

/**
 * Argon2id with the password parameters, so a copied table cannot be searched quickly. The
 * same code and salt always give the same hash, so a typed code is found by its hash with one
 * hash per attempt.
 */
export async function hashRecoveryCode(code: string, salt: string): Promise<string> {
  const hash = await hashRaw(normalizeRecoveryCode(code), {
    ...ARGON2_PARAMS,
    salt: Buffer.from(salt, 'base64'),
    outputLen: 32,
  });
  return hash.toString('hex');
}
