// The jobs and how each queue runs them (ADR 0025).

/** Every job the runner knows. A name is also its queue. */
export const JOB_NAMES = [
  'pricing.build',
  'visibility.build',
  'search.build',
  'notifications.send',
  'sessions.cleanup',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

/** The schema pg-boss keeps its tables in. */
export const JOB_SCHEMA = 'pgboss';

/**
 * Builds are full rebuilds, so one queued and one running is enough: a burst of edits while one
 * waits adds nothing ("stately"). The wait before a build starts gathers the burst.
 */
export const BUILD_DELAY_SECONDS = 15;

export const BUILD_JOBS: readonly JobName[] = ['pricing.build', 'visibility.build', 'search.build'];

/** When the scheduled jobs run, as cron in UTC. */
export const SCHEDULES: Partial<Record<JobName, string>> = {
  // Emails are also sent as soon as a change that queues one commits.
  'notifications.send': '* * * * *',
  'sessions.cleanup': '17 * * * *',
};

/** Three retries with exponential backoff, then the job is failed (ADR 0025). */
export const RETRY = { retryLimit: 3, retryDelay: 5, retryBackoff: true, retryDelayMax: 300 };
