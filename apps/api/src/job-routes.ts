import type { Database } from '@muziris/db';
import type { JobQueue, JobSummary } from '@muziris/jobs';
import { Hono } from 'hono';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';

// The job runner's state under /admin/v1/jobs (ADR 0025), read only: what is waiting or running,
// and what failed. Jobs carry no data, so there is nothing personal to hide.

export interface JobRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  jobs: JobQueue;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface JobEnv {
  Variables: AdminAccessVariables;
}

function jobJson(job: JobSummary) {
  return {
    id: job.id,
    name: job.name,
    state: job.state,
    retryCount: job.retryCount,
    createdAt: job.createdAt.toISOString(),
    startAfter: job.startAfter.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export function jobRoutes(deps: JobRouteDependencies): Hono<JobEnv> {
  const app = new Hono<JobEnv>();
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/', requirePermission('job.view', deps), async (c) => {
    const { queued, failed } = await deps.jobs.list();
    return c.json({ queued: queued.map(jobJson), failed: failed.map(jobJson) });
  });

  return app;
}
