import { PgBoss } from 'pg-boss';
import { BUILD_JOBS, JOB_NAMES, JOB_SCHEMA, RETRY, SCHEDULES, type JobName } from './names.js';
import { asJobDatabase, type JobQueue, type JobStatus, type JobSummary } from './queue.js';

/** What a job does. It reads what it needs itself: job data is always empty. */
export type JobHandler = () => Promise<void>;

/** The logging the runner needs: job names and ids only, never job data (ADR 0025). */
export interface JobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface JobRunnerOptions {
  url: string;
  logger: JobLogger;
  /** Most connections pg-boss holds, apart from the application's own pool. */
  maxConnections?: number;
  /**
   * The handlers, when this process runs the workers. Without them it only enqueues and reads
   * status, as the API does with JOB_WORKERS=false.
   */
  handlers?: Record<JobName, JobHandler>;
}

export interface JobRunner {
  queue: JobQueue;
  stop(): Promise<void>;
}

function pgBoss(url: string, options: { max: number; workers: boolean; migrate: boolean }) {
  return new PgBoss({
    connectionString: url,
    schema: JOB_SCHEMA,
    max: options.max,
    application_name: options.workers ? 'muziris-worker' : 'muziris-api-jobs',
    migrate: options.migrate,
    // Maintenance and cron belong to the processes that run the workers.
    supervise: options.workers,
    schedule: options.workers,
  });
}

/**
 * Installs or upgrades pg-boss's schema and creates the queues. `pnpm db:migrate` runs it, so the
 * running processes need no right to change the schema.
 */
export async function installJobSchema(url: string): Promise<void> {
  const boss = pgBoss(url, { max: 1, workers: false, migrate: true });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    for (const name of JOB_NAMES) {
      if (existing.has(name)) continue;
      await boss.createQueue(name, {
        ...RETRY,
        policy:
          BUILD_JOBS.includes(name) || name === 'notifications.send' ? 'stately' : 'exclusive',
      });
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}

const QUEUED_STATES = new Set(['created', 'retry', 'active']);

interface FailedRow {
  id: string;
  name: string;
  state: string;
  retry_count: number;
  created_on: string | Date;
  start_after: string | Date;
  completed_on: string | Date | null;
}

function summary(job: {
  id: string;
  name: string;
  state: string;
  retryCount: number;
  createdOn: Date;
  startAfter: Date;
  completedOn: Date | null;
}): JobSummary {
  return {
    id: job.id,
    name: job.name as JobName,
    state: job.state as JobSummary['state'],
    retryCount: job.retryCount,
    createdAt: job.createdOn,
    startAfter: job.startAfter,
    completedAt: job.completedOn,
  };
}

/**
 * Starts pg-boss on the application's database. With handlers it also runs every job and keeps
 * the schedules; the API does that by default, so a small install stays one process.
 */
export async function startJobRunner(options: JobRunnerOptions): Promise<JobRunner> {
  const workers = options.handlers !== undefined;
  const boss = pgBoss(options.url, {
    max: options.maxConnections ?? 4,
    workers,
    migrate: false,
  });
  boss.on('error', (error: unknown) => {
    options.logger.error({ err: error }, 'jobs.runner_error');
  });
  await boss.start();

  if (options.handlers) {
    for (const name of JOB_NAMES) {
      const handler = options.handlers[name];
      await boss.work(name, async (jobs) => {
        for (const job of jobs) {
          const started = performance.now();
          try {
            await handler();
          } catch (error) {
            // The error, not the job's data: data could one day hold an email address.
            options.logger.error({ job: name, jobId: job.id, err: error }, 'jobs.failed');
            throw error;
          }
          options.logger.info(
            { job: name, jobId: job.id, ms: Math.round(performance.now() - started) },
            'jobs.done',
          );
        }
      });
    }
    for (const [name, cron] of Object.entries(SCHEDULES)) {
      await boss.schedule(name, cron, null, { tz: 'UTC' });
    }
  }

  const queue: JobQueue = {
    async enqueue(name, enqueueOptions = {}) {
      await boss.send(name, null, {
        ...(enqueueOptions.db ? { db: asJobDatabase(enqueueOptions.db) } : {}),
        ...(enqueueOptions.delaySeconds ? { startAfter: enqueueOptions.delaySeconds } : {}),
      });
    },
    async status(name): Promise<JobStatus> {
      const jobs = await boss.findJobs(name, { queued: true });
      if (jobs.some((j) => j.state === 'active')) return 'running';
      return jobs.some((j) => QUEUED_STATES.has(j.state)) ? 'queued' : 'idle';
    },
    async list() {
      const queued = await Promise.all(
        JOB_NAMES.map((name) => boss.findJobs(name, { queued: true })),
      );
      // Completed jobs are kept for a week, so failed ones are read by state, not by scanning.
      const failed = await boss.getDb().executeSql(
        `select id, name, state, retry_count, created_on, start_after, completed_on
           from ${JOB_SCHEMA}.job where state = 'failed' order by created_on desc limit 50`,
      );
      return {
        queued: queued
          .flat()
          .map(summary)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
        failed: (failed.rows as FailedRow[]).map((row) =>
          summary({
            id: row.id,
            name: row.name,
            state: row.state,
            retryCount: row.retry_count,
            createdOn: new Date(row.created_on),
            startAfter: new Date(row.start_after),
            completedOn: row.completed_on === null ? null : new Date(row.completed_on),
          }),
        ),
      };
    },
  };

  return {
    queue,
    async stop() {
      // Let a running job finish, up to pg-boss's default wait.
      await boss.stop({ graceful: true });
    },
  };
}
