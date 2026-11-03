import type { Database } from '@muziris/db';
import type { JobName, JobQueue } from '@muziris/jobs';
import { jobHandlers } from './jobs.js';
import type { Logger } from './logger.js';

/**
 * A queue for route tests: a job queued by a write is only recorded, as it would wait for the
 * worker, while "Build now" runs its job at once, as if the worker had picked it up.
 */
export function inlineJobs(deps: { db: Database; logger: Logger }) {
  const handlers = jobHandlers(deps);
  const queued: JobName[] = [];
  const queue: JobQueue = {
    async enqueue(name, options = {}) {
      if (options.db) {
        queued.push(name);
        return;
      }
      await handlers[name]();
    },
    status: () => Promise.resolve('idle'),
    list: () => Promise.resolve({ queued: [], failed: [] }),
  };
  return { queue, queued };
}
