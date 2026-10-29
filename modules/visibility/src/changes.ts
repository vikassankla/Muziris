import type { Database } from '@muziris/db';
import { sql } from 'drizzle-orm';
import { buildState } from './db/schema.js';

/** A database handle or an open transaction; both can run statements. */
export type Executor = Pick<Database, 'execute'>;

/**
 * Counts one change to rules. Call it inside the transaction that makes the change, so the
 * count and the change commit together. A running build holds the state row, so this waits for
 * it and the change is counted as not yet built.
 */
export async function recordChange(tx: Executor): Promise<void> {
  await tx.execute(
    sql`insert into ${buildState} (id, change_count) values (1, 1)
        on conflict (id) do update set change_count = ${buildState}.change_count + 1`,
  );
}
