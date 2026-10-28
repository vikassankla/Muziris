import { describe, expect, it } from 'vitest';
import {
  INVITATION_DEFAULT_TTL_MS,
  INVITATION_MAX_TTL_MS,
  INVITATION_MIN_TTL_MS,
  invitationStatus,
  newInvitationSchema,
} from './index.js';

const created = new Date('2026-11-04T10:00:00.000Z');
const expiresAt = new Date(created.getTime() + INVITATION_DEFAULT_TTL_MS);
const at = (iso: string) => new Date(iso);

describe('invitation status', () => {
  it('defaults to seven days', () => {
    expect(expiresAt.toISOString()).toBe('2026-11-11T10:00:00.000Z');
  });

  it.each([
    ['at creation', created, null, null, 'pending'],
    ['a day later', at('2026-11-05T10:00:00.000Z'), null, null, 'pending'],
    ['1 ms before expiry', at('2026-11-11T09:59:59.999Z'), null, null, 'pending'],
    ['exactly at expiry', at('2026-11-11T10:00:00.000Z'), null, null, 'expired'],
    ['1 ms after expiry', at('2026-11-11T10:00:00.001Z'), null, null, 'expired'],
    ['a year later', at('2027-11-11T10:00:00.000Z'), null, null, 'expired'],
    ['accepted, before expiry', at('2026-11-06T00:00:00.000Z'), created, null, 'accepted'],
    ['accepted, after expiry', at('2026-12-01T00:00:00.000Z'), created, null, 'accepted'],
    ['revoked, before expiry', at('2026-11-06T00:00:00.000Z'), null, created, 'revoked'],
    ['revoked, after expiry', at('2026-12-01T00:00:00.000Z'), null, created, 'revoked'],
  ] as const)('%s: %s', (_label, now, acceptedAt, revokedAt, expected) => {
    expect(invitationStatus({ acceptedAt, revokedAt, expiresAt }, now)).toBe(expected);
  });

  it('does not depend on the time zone of the dates', () => {
    // 15:30 in Kolkata is 10:00 UTC: the same instant as the expiry.
    expect(
      invitationStatus(
        { acceptedAt: null, revokedAt: null, expiresAt },
        at('2026-11-11T15:30:00+05:30'),
      ),
    ).toBe('expired');
  });
});

describe('new invitation input', () => {
  const base = {
    customerId: '0b9cc2a4-58b5-4d3e-a7a2-4d2fd3bc9f4b',
    email: 'Priya@Example.COM',
    displayName: 'Priya',
    invitedByUserId: '1f0d8a6e-3c51-4f7e-9b0e-6a1c2d3e4f50',
    now: created,
  };

  it('normalises the email the way identity does and applies the default lifetime', () => {
    const parsed = newInvitationSchema.parse(base);
    expect(parsed.email).toBe('priya@example.com');
    expect(parsed.ttlMs).toBe(INVITATION_DEFAULT_TTL_MS);
  });

  it.each([
    [INVITATION_MIN_TTL_MS - 1, false],
    [INVITATION_MIN_TTL_MS, true],
    [INVITATION_MAX_TTL_MS, true],
    [INVITATION_MAX_TTL_MS + 1, false],
    [1.5 * INVITATION_MIN_TTL_MS, true],
    [INVITATION_MIN_TTL_MS + 0.5, false],
  ])('a lifetime of %d ms is accepted: %j', (ttlMs, ok) => {
    expect(newInvitationSchema.safeParse({ ...base, ttlMs }).success).toBe(ok);
  });

  it.each(['not-an-email', '', 'a@'])('refuses the email %j', (email) => {
    expect(newInvitationSchema.safeParse({ ...base, email }).success).toBe(false);
  });
});
