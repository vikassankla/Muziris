import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

const EMAIL = 'asha@example.com';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  return { logger: createLogger('info', destination), lines };
}

describe('the logger', () => {
  it('writes a failed query without the values it was sent with', () => {
    const { logger, lines } = capture();
    // Shaped as postgres.js's PostgresError, which the API does not import.
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "identity_user_email_uq"'),
      {
        name: 'PostgresError',
        code: '23505',
        detail: `Key (realm, email)=(admin, ${EMAIL}) already exists.`,
        constraint_name: 'identity_user_email_uq',
      },
    );
    const error = new DrizzleQueryError(
      'insert into "identity_user" ("email") values ($1)',
      [EMAIL],
      cause,
    );
    logger.error({ requestId: 'r-12345678', err: error }, 'unhandled error');

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain(EMAIL);
    const entry = JSON.parse(line) as { err: { message: string } };
    // pino adds the causes' messages to the message.
    expect(entry.err.message).toMatch(
      /^Failed query: insert into "identity_user" \("email"\) values \(\$1\): duplicate key/,
    );
    expect(line).toContain('identity_user_email_uq');
  });

  it('still redacts secrets by field name', () => {
    const { logger, lines } = capture();
    logger.info({ password: 'periyar river at dawn' }, 'test');
    expect(lines[0]).not.toContain('periyar');
    expect(lines[0]).toContain('[redacted]');
  });
});
