import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes (256 bits) from the OS CSPRNG, base64url-encoded: 43 characters. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Rejects anything that could not have come from generateToken before it reaches the database. */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** What the database stores in place of the token: SHA-256, hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Lower-cases and trims an email for storage and lookup. It does not try to remove dots or
 * "+tags": providers treat those differently, and guessing wrong would merge two people.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
