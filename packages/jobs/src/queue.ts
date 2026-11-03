import { sql, type SQL } from 'drizzle-orm';
import type { JobName } from './names.js';

/** Anything that runs a query: a database or an open transaction, from @muziris/db. */
export interface Executor {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface EnqueueOptions {
  /**
   * The transaction of the change the job follows. The job is inserted in it, so a rolled-back
   * change enqueues nothing and a committed one is never missed.
   */
  db?: Executor;
  /** Seconds to wait before the job may start. Builds wait to gather a burst of edits. */
  delaySeconds?: number;
}

/** Where a job stands, for the admin banners. */
export type JobStatus = 'queued' | 'running' | 'idle';

export interface JobSummary {
  id: string;
  name: JobName;
  state: 'created' | 'retry' | 'active' | 'failed';
  retryCount: number;
  createdAt: Date;
  startAfter: Date;
  /** When it last ran, for a failed job. */
  completedAt: Date | null;
}

/**
 * What the rest of the code sees of the runner. Modules and routes never import pg-boss (ADR
 * 0025). Job data is always empty: jobs read what they need, so nothing personal is stored.
 */
export interface JobQueue {
  enqueue(name: JobName, options?: EnqueueOptions): Promise<void>;
  status(name: JobName): Promise<JobStatus>;
  /** Jobs waiting or running, and the last failed ones, newest first. */
  list(): Promise<{ queued: JobSummary[]; failed: JobSummary[] }>;
}

/** Splits pg-style text with $1, $2 ... into drizzle SQL with the values bound in their place. */
export function boundSql(text: string, values: readonly unknown[] = []): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part !== '') chunks.push(sql.raw(part));
      return;
    }
    const position = Number(part) - 1;
    if (position < 0 || position >= values.length) {
      throw new RangeError(`The query names $${part}, but has ${String(values.length)} values`);
    }
    // sql.param binds the value as one parameter; a template would spread an array into a list.
    chunks.push(sql`${sql.param(values[position])}`);
  });
  return sql.join(chunks);
}

/** pg-boss's database interface over one of ours, so a job joins the caller's transaction. */
export function asJobDatabase(db: Executor) {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const result = await db.execute(boundSql(text, values));
      return { rows: Array.from(result as Iterable<unknown>) as Record<string, unknown>[] };
    },
  };
}
