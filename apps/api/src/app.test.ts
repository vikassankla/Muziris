import { Writable } from 'node:stream';
import type { Database } from '@muziris/db';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

/** These tests never reach the database; any access is a test bug and fails loudly. */
const unusedDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error('This test must not use the database');
    },
  },
) as Database;

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: createLogger('info', stream), lines };
}

function makeApp(overrides: Partial<AppDependencies> = {}) {
  const { logger, lines } = captureLogs();
  const app = createApp({
    logger,
    db: unusedDatabase,
    pingDatabase: () => Promise.resolve(),
    corsOrigins: ['https://shop.example.com'],
    maxBodyBytes: 1024,
    readinessTimeoutMs: 50,
    ...overrides,
  });
  return { app, lines };
}

describe('health', () => {
  it('reports liveness', async () => {
    const res = await makeApp().app.request('/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    const res = await makeApp().app.request('/health/ready');
    expect(res.status).toBe(200);
  });

  it('reports 503 without leaking the reason when the database fails', async () => {
    const { app, lines } = makeApp({
      pingDatabase: () => Promise.reject(new Error('password authentication failed for user x')),
    });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('password');
    expect(JSON.parse(text)).toEqual({
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
    expect(lines.some((line) => line.includes('readiness check failed'))).toBe(true);
  });

  it('reports 503 when the database hangs', async () => {
    const { app } = makeApp({ pingDatabase: () => new Promise(() => undefined) });
    expect((await app.request('/health/ready')).status).toBe(503);
  });
});

describe('security headers', () => {
  it('sets strict headers on every response', async () => {
    const res = await makeApp().app.request('/health/live');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('CORS', () => {
  it('allows a listed origin', async () => {
    const res = await makeApp().app.request('/health/live', {
      headers: { Origin: 'https://shop.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
  });

  it('does not allow an unlisted origin', async () => {
    const res = await makeApp().app.request('/health/live', {
      headers: { Origin: 'https://evil.example.net' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('request ids', () => {
  it('echoes a well-formed client id', async () => {
    const res = await makeApp().app.request('/health/live', {
      headers: { 'X-Request-Id': 'client-abc-12345' },
    });
    expect(res.headers.get('x-request-id')).toBe('client-abc-12345');
  });

  it('replaces an id that could inject into logs', async () => {
    const res = await makeApp().app.request('/health/live', {
      headers: { 'X-Request-Id': 'bad id {"level":60,"msg":"forged"}' },
    });
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errors', () => {
  it('answers unknown routes with problem+json', async () => {
    const res = await makeApp().app.request('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 404, code: 'not_found', instance: '/nope' });
  });

  it('rejects bodies over the limit', async () => {
    const { app } = makeApp();
    app.post('/echo', async (c) => c.json(await c.req.json()));
    const res = await app.request('/echo', {
      method: 'POST',
      body: JSON.stringify({ data: 'x'.repeat(4096) }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'payload_too_large' });
  });

  it('hides internal error details from the caller', async () => {
    const { app, lines } = makeApp();
    app.get('/boom', () => {
      throw new Error('connection string postgres://user:secret@db');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({ code: 'internal_error' });
    expect(lines.some((line) => line.includes('unhandled error'))).toBe(true);
  });
});

describe('logging', () => {
  it('redacts secrets in structured fields', () => {
    const { logger, lines } = captureLogs();
    logger.info({ password: 'hunter2', headers: { authorization: 'Bearer abc' } }, 'login');
    const entry = lines.join('');
    expect(entry).not.toContain('hunter2');
    expect(entry).not.toContain('Bearer abc');
    expect(entry).toContain('[redacted]');
  });

  it('redacts payment gateway keys and client secrets (ADR 0019)', () => {
    const { logger, lines } = captureLogs();
    logger.info(
      {
        stripe: { secretKey: 'sk_test_hidden', webhookSecret: 'whsec_hidden' },
        razorpay: { keySecret: 'rzp_hidden' },
        start: { clientSecret: 'pi_1_secret_hidden' },
      },
      'payments',
    );
    expect(lines.join('')).not.toMatch(/hidden/);
  });

  it('redacts the SMTP URL, which can carry the mail password (ADR 0020)', () => {
    const { logger, lines } = captureLogs();
    logger.info({ mail: { smtpUrl: 'smtps://u:hidden@mail' }, smtpUrl: 'smtp://hidden' }, 'mail');
    expect(lines.join('')).not.toMatch(/hidden/);
  });

  it('logs path but never the query string', async () => {
    const { app, lines } = makeApp();
    await app.request('/health/live?token=abc123');
    const entry = lines.find((line) => line.includes('"request"')) ?? '';
    expect(entry).toContain('"path":"/health/live"');
    expect(entry).not.toContain('abc123');
  });
});

describe('loadEnv', () => {
  const valid = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
  const productionMail = {
    SMTP_URL: 'smtps://mailer:s3cret-mail@mail.example.com:465',
    MAIL_FROM: 'Shop <orders@example.com>',
    STOREFRONT_PUBLIC_URL: 'https://shop.example.com',
    ADMIN_PUBLIC_URL: 'https://admin.example.com',
    // Required in production too (ADR 0026); a test value.
    ADMIN_TOTP_KEY: Buffer.alloc(32, 2).toString('base64'),
  };

  it('applies defaults', () => {
    expect(loadEnv(valid)).toMatchObject({ PORT: 4000, HOST: '127.0.0.1', CORS_ORIGINS: [] });
  });

  it('normalises origins', () => {
    expect(
      loadEnv({ ...valid, CORS_ORIGINS: 'https://a.example.com/, http://localhost:5173' })
        .CORS_ORIGINS,
    ).toEqual(['https://a.example.com', 'http://localhost:5173']);
  });

  it('names the bad variable without echoing secret values', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://u:topsecret@h/db' })).toThrow(/DATABASE_URL/);
    try {
      loadEnv({ DATABASE_URL: 'mysql://u:topsecret@h/db' });
    } catch (error) {
      expect(String(error)).not.toContain('topsecret');
    }
  });

  it('refuses plain http origins in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        ...productionMail,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'http://shop.example.com',
      }),
    ).toThrow(/https/);
  });

  it('runs storefront query text outside production only', () => {
    expect(loadEnv(valid).STOREFRONT_ADHOC_QUERIES).toBe('allow');
    expect(
      loadEnv({ ...valid, ...productionMail, NODE_ENV: 'production' }).STOREFRONT_ADHOC_QUERIES,
    ).toBe('deny');
    expect(loadEnv({ ...valid, STOREFRONT_ADHOC_QUERIES: 'deny' }).STOREFRONT_ADHOC_QUERIES).toBe(
      'deny',
    );
    expect(() =>
      loadEnv({
        ...valid,
        ...productionMail,
        NODE_ENV: 'production',
        STOREFRONT_ADHOC_QUERIES: 'allow',
      }),
    ).toThrow(/STOREFRONT_ADHOC_QUERIES/);
  });

  it('reads mail settings, required in production, without echoing the SMTP password', () => {
    expect(loadEnv(valid).mail).toMatchObject({
      smtpUrl: undefined,
      storefrontUrl: 'http://localhost:5174',
    });
    expect(loadEnv({ ...valid, ...productionMail, NODE_ENV: 'production' }).mail.smtpUrl).toBe(
      productionMail.SMTP_URL,
    );
    let message = '';
    try {
      loadEnv({ ...valid, NODE_ENV: 'production', SMTP_URL: 'http://mailer:s3cret-mail@x' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('SMTP_URL');
    expect(message).toContain('STOREFRONT_PUBLIC_URL: required in production');
    expect(message).not.toContain('s3cret-mail');
  });

  it('reads ADMIN_TOTP_KEY, required in production, without echoing it', () => {
    expect(loadEnv(valid).twoFactorKey).toBeUndefined();
    expect(
      loadEnv({ ...valid, ...productionMail, NODE_ENV: 'production' }).twoFactorKey,
    ).toBeDefined();
    expect(() =>
      loadEnv({ ...valid, ...productionMail, NODE_ENV: 'production', ADMIN_TOTP_KEY: undefined }),
    ).toThrow('ADMIN_TOTP_KEY: required in production');
    let message = '';
    try {
      loadEnv({ ...valid, ADMIN_TOTP_KEY: Buffer.alloc(16, 1).toString('base64') });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('ADMIN_TOTP_KEY must be 32 bytes in base64');
    expect(message).not.toContain('c2hvcnQta2V5LXNlY3JldA');
    expect(JSON.stringify(loadEnv({ ...valid, ...productionMail }))).not.toContain(
      productionMail.ADMIN_TOTP_KEY,
    );
  });

  it('reads payment gateways, refusing a half-set one without echoing its keys', () => {
    expect(loadEnv(valid).payments).toEqual({});
    expect(
      loadEnv({
        ...valid,
        RAZORPAY_KEY_ID: 'rzp_test_1',
        RAZORPAY_KEY_SECRET: 'k',
        RAZORPAY_WEBHOOK_SECRET: 'w',
      }).payments.razorpay?.keyId,
    ).toBe('rzp_test_1');
    let message = '';
    try {
      loadEnv({ ...valid, STRIPE_SECRET_KEY: 'sk_test_topsecret' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET/);
    expect(message).not.toContain('topsecret');
  });
});
