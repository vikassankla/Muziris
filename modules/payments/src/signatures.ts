import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook signatures (ADR 0019). Only a correctly signed webhook may change a payment, so these
// are checked before the body is even parsed. Comparisons are constant time.

/** Stripe's default tolerance: a signed timestamp older or newer than this is refused. */
export const STRIPE_TOLERANCE_SECONDS = 300;

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function sameHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Checks a `Stripe-Signature` header (`t=<unix seconds>,v1=<hex>[,v1=…]`): one v1 must be the
 * HMAC-SHA256 of `<t>.<raw body>` with the endpoint's secret, and t must be within the tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now: Date,
  toleranceSeconds = STRIPE_TOLERANCE_SECONDS,
): boolean {
  if (header === undefined || header.length > 2048) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value !== undefined) signatures.push(value);
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((s) => sameHex(s, expected));
}

/** Checks an `X-Razorpay-Signature` header: the HMAC-SHA256 hex of the raw body. */
export function verifyRazorpaySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (header === undefined || header.length > 256) return false;
  return sameHex(header, hmacHex(secret, rawBody));
}
