import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

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
      loadEnv({ ...valid, NODE_ENV: 'production', CORS_ORIGINS: 'http://shop.example.com' }),
    ).toThrow(/https/);
  });
});
