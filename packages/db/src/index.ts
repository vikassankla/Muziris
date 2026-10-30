import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
export { prepareTestDatabase } from './testing.js';

export type Database = PostgresJsDatabase;

export interface DatabaseOptions {
  /** Connection string, for example postgres://user:pass@host:5432/db */
  url: string;
  /** Maximum pooled connections for this process. */
  maxConnections?: number;
  /** Name shown in pg_stat_activity, useful for telling the API and workers apart. */
  applicationName?: string;
  /** Statement timeout in milliseconds; protects the pool from runaway queries. */
  statementTimeoutMs?: number;
  /**
   * Called once per statement sent, with nothing about it, so tests can count queries (the
   * storefront's batching, ADR 0014). It cannot leak query text or parameters into logs.
   */
  onQuery?: () => void;
}

export interface DatabaseHandle {
  db: Database;
  /** Checks the database answers; used by readiness probes. */
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    connection: {
      application_name: options.applicationName ?? 'muziris',
      statement_timeout: options.statementTimeoutMs ?? 15_000,
    },
    // Never print connection details or query parameters in driver notices.
    onnotice: () => undefined,
  });
  const onQuery = options.onQuery;
  const db = onQuery
    ? drizzle(sql, {
        logger: {
          logQuery: () => {
            onQuery();
          },
        },
      })
    : drizzle(sql);
  return {
    db,
    ping: async () => {
      await sql`select 1`;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
