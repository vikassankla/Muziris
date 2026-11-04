import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './content-security-policy.js';

describe('the content security policy', () => {
  const directive = (name: string) =>
    CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

  it('runs scripts and sends requests to this origin only', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
  });
});
