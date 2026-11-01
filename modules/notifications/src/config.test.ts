import { describe, expect, it } from 'vitest';
import { mailConfigFromEnv } from './config.js';
import { sendErrorCode } from './outbox.js';

describe('mail configuration', () => {
  it('has development defaults and no SMTP when nothing is set', () => {
    expect(mailConfigFromEnv({}, { production: false })).toEqual({
      smtpUrl: undefined,
      from: 'Muziris <no-reply@muziris.localhost>',
      storefrontUrl: 'http://localhost:5174',
    });
  });

  it('reads the variables, trimming the storefront URL', () => {
    expect(
      mailConfigFromEnv(
        {
          SMTP_URL: 'smtps://user:pa55@mail.example.com:465',
          MAIL_FROM: 'Kochi Bearings <orders@example.in>',
          STOREFRONT_PUBLIC_URL: 'https://shop.example.in/b2b/',
        },
        { production: true },
      ),
    ).toEqual({
      smtpUrl: 'smtps://user:pa55@mail.example.com:465',
      from: 'Kochi Bearings <orders@example.in>',
      storefrontUrl: 'https://shop.example.in/b2b',
    });
  });

  it('requires all three in production, and never echoes a value', () => {
    expect(() => mailConfigFromEnv({}, { production: true })).toThrow(
      /SMTP_URL: required in production[\s\S]*MAIL_FROM[\s\S]*STOREFRONT_PUBLIC_URL/,
    );
    let message = '';
    try {
      mailConfigFromEnv(
        {
          SMTP_URL: 'http://user:s3cret-password@mail',
          STOREFRONT_PUBLIC_URL: 'http://shop.example.in?x=1',
        },
        { production: true },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SMTP_URL: expected smtp:// or smtps://');
    expect(message).toContain('STOREFRONT_PUBLIC_URL');
    expect(message).not.toContain('s3cret-password');
  });
});

describe('send error codes', () => {
  it('keeps the SMTP reply code or nodemailer error code, never the text', () => {
    expect(sendErrorCode({ responseCode: 550, message: '550 asha@example.in unknown' })).toBe(
      'smtp_550',
    );
    expect(sendErrorCode({ code: 'ECONNECTION', message: 'connect ECONNREFUSED' })).toBe(
      'ECONNECTION',
    );
    expect(sendErrorCode({ code: 'asha@example.in' })).toBe('send_failed');
    expect(sendErrorCode(new Error('boom'))).toBe('send_failed');
  });
});
