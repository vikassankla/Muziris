import { DrizzleQueryError } from 'drizzle-orm/errors';

// Database errors carry the values a query was sent with: Drizzle puts them in the message and
// in `params`, and PostgreSQL repeats them in `detail` ("Key (email)=(...) already exists") and
// `where`. Those values can be emails, addresses, password hashes or token hashes, so an error
// is passed through withoutQueryValues before it is logged or stored.

/** What a PostgreSQL error may keep: the codes and names that say what failed, never values. */
const SAFE_POSTGRES_FIELDS = [
  'code',
  'severity',
  'routine',
  'schema_name',
  'table_name',
  'column_name',
  'constraint_name',
] as const;

/** How deep a chain of causes is followed; anything deeper is dropped. */
const MAX_CAUSE_DEPTH = 5;

function isPostgresError(error: Error): error is Error & Record<string, unknown> {
  return error.name === 'PostgresError' && 'code' in error;
}

/** The error's stack with its first line, the message, replaced by the given one. */
function stackWithMessage(error: Error, name: string, message: string): string | undefined {
  if (error.stack === undefined) return undefined;
  const frames = error.stack.split('\n').filter((line) => line.startsWith('    at '));
  return [`${name}: ${message}`, ...frames].join('\n');
}

function copyOf(error: Error, name: string, message: string, cause: unknown): Error {
  const copy = new Error(message);
  copy.name = name;
  // Assigned, as Drizzle does, so loggers that only write own enumerable fields keep it.
  if (cause !== undefined) copy.cause = cause;
  const stack = stackWithMessage(error, name, message);
  if (stack !== undefined) copy.stack = stack;
  return copy;
}

/**
 * A copy of an error, and of the errors it was caused by, without the values its queries were
 * sent with. The query text, PostgreSQL's code, and the table, column and constraint names stay,
 * so the logs still say what failed. Anything that is not a database error is returned as is.
 */
export function withoutQueryValues(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  if (depth >= MAX_CAUSE_DEPTH) return undefined;
  const cause = error.cause === undefined ? undefined : withoutQueryValues(error.cause, depth + 1);

  if (error instanceof DrizzleQueryError) {
    return copyOf(error, 'DrizzleQueryError', `Failed query: ${error.query}`, cause);
  }
  if (isPostgresError(error)) {
    const copy = copyOf(error, error.name, error.message, cause) as Error & Record<string, unknown>;
    for (const field of SAFE_POSTGRES_FIELDS) {
      if (error[field] !== undefined) copy[field] = error[field];
    }
    return copy;
  }
  // Another error is kept unless one of its causes had to be cleaned.
  return cause === error.cause ? error : copyOf(error, error.name, error.message, cause);
}
