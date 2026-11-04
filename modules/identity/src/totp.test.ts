import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  generateRecoverySalt,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  matchTotp,
  normalizeRecoveryCode,
  parseTotpKey,
  totpCode,
  totpStep,
  totpUri,
} from './totp.js';

// The RFCs' own secret: the ASCII string "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
/** RFC_SECRET in base32. */
const RFC_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const KEY = parseTotpKey(Buffer.alloc(32, 7).toString('base64'));
const USER = '7b0a3c1e-1d55-4f4e-9a57-0d7c5d1f2a10';

describe('HOTP known answers (RFC 4226, appendix D)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %i gives %s', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected);
  });
});

describe('TOTP known answers (RFC 6238, appendix B, SHA-1)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('at %i seconds gives %s', (seconds, expected) => {
    const at = new Date(seconds * 1000);
    expect(totpCode(RFC_SECRET, at, 8)).toBe(expected);
    // Six digits are the last six of the eight.
    expect(totpCode(RFC_SECRET, at)).toBe(expected.slice(2));
  });
});

describe('matchTotp', () => {
  const now = new Date('2026-11-03T10:00:15Z');
  const step = totpStep(now);

  it('accepts the current code and one step either side, and says which step', () => {
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), now)).toBe(step);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
  });

  it('refuses codes two steps away, wrong codes and anything not six digits', () => {
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, '000000', now)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, '12345', now)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, 'abcdef', now)).toBeUndefined();
  });

  it('ignores spaces typed inside the code', () => {
    const code = hotp(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
  });
});

describe('base32', () => {
  it('encodes the RFC secret as authenticator apps expect', () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_BASE32);
  });

  it('round-trips a random secret, ignoring case, spaces and padding', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    const text = base32Encode(secret);
    expect(text).toHaveLength(32);
    expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(secret);
  });
});

describe('totpUri', () => {
  it('names the issuer and account and carries the secret', () => {
    const uri = new URL(totpUri(RFC_SECRET, 'Muziris', 'meera@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Muziris:meera@example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: RFC_BASE32,
      issuer: 'Muziris',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});

describe('secret encryption', () => {
  it('round-trips, and never stores the same text twice', () => {
    const secret = generateTotpSecret();
    const first = encryptSecret(KEY, USER, secret);
    expect(first).toMatch(/^v1:/);
    expect(first).not.toBe(encryptSecret(KEY, USER, secret));
    expect(decryptSecret(KEY, USER, first)).toEqual(secret);
  });

  it('refuses another key, another user and a changed text', () => {
    const stored = encryptSecret(KEY, USER, generateTotpSecret());
    const otherKey = parseTotpKey(Buffer.alloc(32, 8).toString('base64'));
    expect(() => decryptSecret(otherKey, USER, stored)).toThrow();
    expect(() => decryptSecret(KEY, 'another-user', stored)).toThrow();
    const raw = Buffer.from(stored.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(KEY, USER, `v1:${raw.toString('base64')}`)).toThrow();
  });

  it('takes only a 32-byte base64 key, and never quotes it in the error', () => {
    expect(() => parseTotpKey(Buffer.alloc(16).toString('base64'))).toThrow(
      'ADMIN_TOTP_KEY must be 32 bytes in base64',
    );
    expect(() => parseTotpKey('CHANGE_ME')).toThrow('ADMIN_TOTP_KEY must be 32 bytes in base64');
  });
});

describe('recovery codes', () => {
  it('are two groups of five with no look-alike characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRecoveryCode()).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    }
  });

  it('hash the same however they are typed', async () => {
    const salt = generateRecoverySalt();
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(await hashRecoveryCode('abcde fghjk', salt)).toBe(
      await hashRecoveryCode('ABCDE-FGHJK', salt),
    );
    expect(await hashRecoveryCode('ABCDE-FGHJK', salt)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash differently under another salt', async () => {
    expect(await hashRecoveryCode('ABCDE-FGHJK', generateRecoverySalt())).not.toBe(
      await hashRecoveryCode('ABCDE-FGHJK', generateRecoverySalt()),
    );
  });
});
