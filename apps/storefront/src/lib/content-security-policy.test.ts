// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './content-security-policy.js';

describe('the content security policy', () => {
  const directive = (name: string) =>
    CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

  it('runs scripts from this origin and the payment gateways only', () => {
    expect(directive('script-src')).toBe(
      "script-src 'self' https://js.stripe.com https://checkout.razorpay.com",
    );
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(directive('object-src')).toBe("object-src 'none'");
  });

  it('lets the gateways’ payment forms run in their own frames', () => {
    expect(directive('frame-src')).toContain('https://js.stripe.com');
    expect(directive('frame-src')).toContain('https://api.razorpay.com');
  });
});
