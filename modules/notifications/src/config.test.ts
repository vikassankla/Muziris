import { describe, expect, it } from 'vitest';
import { mailConfigFromEnv } from './config.js';
import { sendErrorCode } from './outbox.js';

describe('mail configuration', () => {
  it('has development defaults and no SMTP when nothing is set', () => {
    expect(mailConfigFromEnv({}, { production: false })).toEqual({
      smtpUrl: undefined,
      from: 'Muziris <no-reply@muziris.localhost>',
      storefrontUrl: 'http://localhost:5174',
      adminUrl: 'http://localhost:5173',
    });
  });

  it('reads the variables, trimming the app URLs', () => {
    expect(
      mailConfigFromEnv(
        {
          SMTP_URL: 'smtps://user:pa55@mail.example.com:465',
          MAIL_FROM: 'Kochi Bearings <orders@example.in>',
          STOREFRONT_PUBLIC_URL: 'https://shop.example.in/b2b/',
          ADMIN_PUBLIC_URL: 'https://admin.example.in/',
        },
        { production: true },
      ),
    ).toEqual({
      smtpUrl: 'smtps://user:pa55@mail.example.com:465',
      from: 'Kochi Bearings <orders@example.in>',
      storefrontUrl: 'https://shop.example.in/b2b',
      adminUrl: 'https://admin.example.in',
    });
  });

  it('requires all four in production, and never echoes a value', () => {
    expect(() => mailConfigFromEnv({}, { production: true })).toThrow(
      /SMTP_URL: required in production[\s\S]*MAIL_FROM[\s\S]*STOREFRONT_PUBLIC_URL[\s\S]*ADMIN_PUBLIC_URL/,
    );
    let message = '';
    try {
      mailConfigFromEnv(
        {
          SMTP_URL: 'http://user:s3cret-password@mail',
          STOREFRONT_PUBLIC_URL: 'http://shop.example.in?x=1',
          ADMIN_PUBLIC_URL: 'http://admin.example.in',
        },
        { production: true },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SMTP_URL: expected smtp:// or smtps://');
    expect(message).toContain('STOREFRONT_PUBLIC_URL');
    expect(message).toContain('ADMIN_PUBLIC_URL: production links must use https');
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
