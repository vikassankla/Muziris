import { DrizzleQueryError } from 'drizzle-orm/errors';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { withoutQueryValues } from './errors.js';

const EMAIL = 'asha@example.com';
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

/** The driver builds its errors from the server's fields; its types only show a message. */
const PostgresError = postgres.PostgresError as unknown as new (
  fields: Record<string, string>,
) => postgres.PostgresError;

function uniqueViolation() {
  return new PostgresError({
    message: 'duplicate key value violates unique constraint "identity_user_email_uq"',
    severity: 'ERROR',
    code: '23505',
    detail: `Key (realm, email)=(admin, ${EMAIL}) already exists.`,
    where: `SQL statement with ${EMAIL}`,
    schema_name: 'public',
    table_name: 'identity_user',
    constraint_name: 'identity_user_email_uq',
    routine: '_bt_check_unique',
  });
}

function failedInsert() {
  return new DrizzleQueryError(
    'insert into "identity_user" ("email", "password_hash") values ($1, $2)',
    [EMAIL, HASH],
    uniqueViolation(),
  );
}

/** Everything a logger or pg-boss could write out of the error, as one string. */
function written(error: unknown): string {
  const seen: unknown[] = [];
  let current = error;
  while (current instanceof Error) {
    seen.push({
      ...Object.fromEntries(Object.entries(current)),
      name: current.name,
      message: current.message,
      stack: current.stack,
    });
    current = current.cause;
  }
  return JSON.stringify(seen);
}

describe('withoutQueryValues', () => {
  it('keeps what failed and drops the values a failed query was sent with', () => {
    const original = failedInsert();
    expect(written(original)).toContain(EMAIL);

    const safe = withoutQueryValues(original);
    const out = written(safe);
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain('argon2id');
    expect(safe).toBeInstanceOf(Error);
    const error = safe as Error;
    expect(error.name).toBe('DrizzleQueryError');
    expect(error.message).toBe(
      'Failed query: insert into "identity_user" ("email", "password_hash") values ($1, $2)',
    );
    expect(error.stack?.split('\n')[0]).toBe(`DrizzleQueryError: ${error.message}`);
    expect(error.cause).toMatchObject({
      name: 'PostgresError',
      code: '23505',
      table_name: 'identity_user',
      constraint_name: 'identity_user_email_uq',
    });
    expect(error.cause).not.toHaveProperty('detail');
    expect(error.cause).not.toHaveProperty('where');
  });

  it('cleans a database error found among the causes of another', () => {
    const wrapped = new Error('Could not save the admin user', { cause: failedInsert() });
    const safe = withoutQueryValues(wrapped) as Error;
    expect(safe.message).toBe('Could not save the admin user');
    expect(written(safe)).not.toContain(EMAIL);
    // The original is left alone.
    expect(written(wrapped)).toContain(EMAIL);
  });

  it('returns any other error, and anything that is not an error, unchanged', () => {
    const plain = new Error('Timed out after 2000 ms', { cause: new Error('socket closed') });
    expect(withoutQueryValues(plain)).toBe(plain);
    expect(withoutQueryValues('text')).toBe('text');
    expect(withoutQueryValues(undefined)).toBeUndefined();
  });

  it('stops following causes after a few levels', () => {
    let error: Error = failedInsert();
    for (let i = 0; i < 10; i += 1) error = new Error(`level ${String(i)}`, { cause: error });
    expect(written(withoutQueryValues(error))).not.toContain(EMAIL);
  });
});
