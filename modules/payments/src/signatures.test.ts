import { describe, expect, it } from 'vitest';
import { verifyRazorpaySignature, verifyStripeSignature } from './signatures.js';

// Known answers computed independently with openssl, for example:
//   printf '%s' "1730419200.$body" | openssl dgst -sha256 -hmac 'whsec_test_secret'

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const v1 = '12e3d5f93ccf7bc83270ddb59997ae185d1b5b2c5e7693a83ad5ef617a79f89b';
  const at = new Date(1730419200 * 1000);

  it('accepts the signature of the timestamp and raw body', () => {
    expect(verifyStripeSignature(body, `t=1730419200,v1=${v1}`, 'whsec_test_secret', at)).toBe(
      true,
    );
  });

  it('accepts any of several v1 signatures, as during a secret roll', () => {
    const header = `t=1730419200,v1=${'0'.repeat(64)},v0=abc,v1=${v1}`;
    expect(verifyStripeSignature(body, header, 'whsec_test_secret', at)).toBe(true);
  });

  it.each([
    ['another secret', body, `t=1730419200,v1=${v1}`, 'whsec_other', at],
    ['a changed body', `${body} `, `t=1730419200,v1=${v1}`, 'whsec_test_secret', at],
    ['a changed timestamp', body, `t=1730419201,v1=${v1}`, 'whsec_test_secret', at],
    [
      'a stale timestamp',
      body,
      `t=1730419200,v1=${v1}`,
      'whsec_test_secret',
      new Date(at.getTime() + 301_000),
    ],
    ['no timestamp', body, `v1=${v1}`, 'whsec_test_secret', at],
    ['no header', body, undefined, 'whsec_test_secret', at],
    ['a short signature', body, `t=1730419200,v1=${v1.slice(0, 10)}`, 'whsec_test_secret', at],
  ])('refuses %s', (_name, b, header, secret, now) => {
    expect(verifyStripeSignature(b, header, secret, now)).toBe(false);
  });
});

describe('verifyRazorpaySignature', () => {
  const body = '{"event":"payment.captured","payload":{}}';
  const signature = '5549a081034a4e379fee1975ff1b95d07c15a1300c0f227f990e40f70551bd31';

  it('accepts the HMAC of the raw body', () => {
    expect(verifyRazorpaySignature(body, signature, 'razorpay_webhook_secret')).toBe(true);
  });

  it.each([
    ['another secret', body, signature, 'other'],
    [
      'a changed body',
      '{"event":"payment.failed","payload":{}}',
      signature,
      'razorpay_webhook_secret',
    ],
    ['upper-case hex', body, signature.toUpperCase(), 'razorpay_webhook_secret'],
    ['no header', body, undefined, 'razorpay_webhook_secret'],
  ])('refuses %s', (_name, b, header, secret) => {
    expect(verifyRazorpaySignature(b, header, secret)).toBe(false);
  });
});
