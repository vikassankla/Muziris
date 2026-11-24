import { describe, expect, it } from 'vitest';
import { isRecipientRefused } from './outbox.js';
import { postmarkConfigFromEnv, postmarkHeaders, webhookCredentialsMatch } from './postmark.js';

// Postmark's configuration and headers (ADR 0032).

const PASSWORD = 'a-long-random-webhook-password-1234';

describe('Postmark configuration', () => {
  it('uses the outbound stream and has no webhook when nothing is set', () => {
    expect(postmarkConfigFromEnv({})).toEqual({ messageStream: 'outbound', webhook: undefined });
  });

  it('reads the stream and the webhook credentials', () => {
    expect(
      postmarkConfigFromEnv({
        POSTMARK_MESSAGE_STREAM: ' transactional ',
        POSTMARK_WEBHOOK_USER: 'muziris',
        POSTMARK_WEBHOOK_PASSWORD: PASSWORD,
      }),
    ).toEqual({ messageStream: 'transactional', webhook: { user: 'muziris', password: PASSWORD } });
  });

  it('refuses one webhook variable without the other, a short password or a bad stream, never echoing a value', () => {
    let message = '';
    try {
      postmarkConfigFromEnv({ POSTMARK_WEBHOOK_PASSWORD: 'short-s3cret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('POSTMARK_WEBHOOK_USER: required with POSTMARK_WEBHOOK_PASSWORD');
    expect(message).toContain('POSTMARK_WEBHOOK_PASSWORD: at least 24 characters');
    expect(message).not.toContain('short-s3cret');
    expect(() => postmarkConfigFromEnv({ POSTMARK_WEBHOOK_USER: 'muziris' })).toThrow(
      'POSTMARK_WEBHOOK_PASSWORD: required with POSTMARK_WEBHOOK_USER',
    );
    expect(() =>
      postmarkConfigFromEnv({ POSTMARK_WEBHOOK_USER: 'a:b', POSTMARK_WEBHOOK_PASSWORD: PASSWORD }),
    ).toThrow('POSTMARK_WEBHOOK_USER: letters, digits, dots, dashes and underscores only');
    expect(() => postmarkConfigFromEnv({ POSTMARK_MESSAGE_STREAM: 'two words' })).toThrow(
      'POSTMARK_MESSAGE_STREAM',
    );
  });
});

describe('Postmark headers', () => {
  const id = '6f1b0c52-3b8e-4a53-9a59-1f0d2a7e6c11';

  it('adds the stream and the outbox id when the relay is Postmark', () => {
    expect(postmarkHeaders('smtp://token:token@smtp.postmarkapp.com:587', id, 'outbound')).toEqual({
      'X-PM-Message-Stream': 'outbound',
      'X-PM-Metadata-outbox-id': id,
    });
    expect(postmarkHeaders('smtps://t:t@SMTP.POSTMARKAPP.COM', id, 'outbound')).toHaveProperty(
      'X-PM-Metadata-outbox-id',
      id,
    );
  });

  it('adds nothing for any other relay', () => {
    for (const url of [
      'smtp://localhost:1025',
      'smtp://u:p@smtp.postmarkapp.com.example.com:587',
      'smtp://smtp.postmarkapp.com@evil.example.com',
      'not a url',
    ]) {
      expect(postmarkHeaders(url, id, 'outbound')).toEqual({});
    }
  });
});

describe('webhook credentials', () => {
  const expected = { user: 'muziris', password: PASSWORD };
  const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

  it('accepts only the exact user and password', () => {
    expect(webhookCredentialsMatch(basic(`muziris:${PASSWORD}`), expected)).toBe(true);
    expect(webhookCredentialsMatch(basic(`muziris:${PASSWORD}x`), expected)).toBe(false);
    expect(webhookCredentialsMatch(basic(`Muziris:${PASSWORD}`), expected)).toBe(false);
    expect(webhookCredentialsMatch(basic(`muziris`), expected)).toBe(false);
    expect(webhookCredentialsMatch(`Bearer ${PASSWORD}`, expected)).toBe(false);
    expect(webhookCredentialsMatch(undefined, expected)).toBe(false);
    expect(webhookCredentialsMatch('Basic !!!', expected)).toBe(false);
  });
});

describe('refused recipients', () => {
  it('is a 5xx reply to RCPT TO only', () => {
    const refusal = (command: string, responseCode: number) => ({
      code: 'EENVELOPE',
      command,
      responseCode,
    });
    expect(isRecipientRefused(refusal('RCPT TO', 550))).toBe(true);
    expect(isRecipientRefused(refusal('RCPT TO', 553))).toBe(true);
    expect(isRecipientRefused(refusal('RCPT TO', 450))).toBe(false);
    expect(isRecipientRefused(refusal('MAIL FROM', 550))).toBe(false);
    expect(isRecipientRefused(refusal('DATA', 554))).toBe(false);
    expect(isRecipientRefused({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 })).toBe(
      false,
    );
    expect(isRecipientRefused(new Error('down'))).toBe(false);
  });
});
