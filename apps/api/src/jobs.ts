import type { Database } from '@muziris/db';
import { deleteDeadSessions, pruneRateLimits } from '@muziris/identity';
import { BUILD_DELAY_SECONDS, type JobHandler, type JobName, type JobQueue } from '@muziris/jobs';
import { sendDueEmails, type MailTransport } from '@muziris/notifications';
import { rebuildCombinedPrices } from '@muziris/pricing';
import { rebuildSearchIndex } from '@muziris/search';
import { rebuildVisibility } from '@muziris/visibility';
import type { Logger } from './logger.js';

// What each job does (ADR 0025). The builds are the same full rebuilds the CLI commands run, and
// the email sender claims each message once, so every job can run again safely.

/** Rate-limit counters are kept this long after their window ends; the longest window is 10 minutes. */
const RATE_LIMIT_RETENTION_MS = 60 * 60_000;

export function jobHandlers(deps: {
  db: Database;
  logger: Logger;
  /** Without one, emails wait in the outbox (no SMTP_URL). */
  transport?: MailTransport;
  now?: () => Date;
}): Record<JobName, JobHandler> {
  const now = deps.now ?? (() => new Date());
  return {
    'pricing.build': async () => {
      const result = await rebuildCombinedPrices(deps.db);
      deps.logger.info({ ...result }, 'pricing.combined_prices_built');
    },
    'visibility.build': async () => {
      const result = await rebuildVisibility(deps.db);
      deps.logger.info({ ...result }, 'visibility.built');
    },
    'search.build': async () => {
      const result = await rebuildSearchIndex(deps.db);
      deps.logger.info({ ...result }, 'search.built');
    },
    // Logs counts, and the id and kind of an email that gave up: never recipients or bodies.
    'notifications.send': async () => {
      if (!deps.transport) return;
      const result = await sendDueEmails(deps.db, deps.transport, now());
      if (result.sent > 0 || result.retrying > 0) {
        deps.logger.info({ sent: result.sent, retrying: result.retrying }, 'emails.sent');
      }
      for (const email of result.failed) {
        deps.logger.error(
          { emailId: email.id, kind: email.kind, lastError: email.lastError },
          'emails.failed',
        );
      }
    },
    'sessions.cleanup': async () => {
      const at = now();
      const sessions = await deleteDeadSessions(deps.db, at);
      const counters = await pruneRateLimits(
        deps.db,
        new Date(at.getTime() - RATE_LIMIT_RETENTION_MS),
      );
      deps.logger.info({ sessions, counters }, 'sessions.cleaned_up');
    },
  };
}

/**
 * Runs a write and enqueues the build it calls for in one transaction, so a rolled-back write
 * enqueues nothing and a committed one is never missed (ADR 0025). The build waits a little to
 * gather a burst of edits.
 */
export async function writeAndBuild<T>(
  deps: { db: Database; jobs: JobQueue },
  builds: readonly JobName[],
  write: (db: Database) => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    // Module functions run in the transaction; their own db.transaction() becomes a savepoint.
    const result = await write(tx);
    for (const name of builds) {
      await deps.jobs.enqueue(name, { db: tx, delaySeconds: BUILD_DELAY_SECONDS });
    }
    return result;
  });
}

/** A queue that drops every job: for tests of routes that do not look at their jobs. */
export const NO_JOBS: JobQueue = {
  enqueue: () => Promise.resolve(),
  status: () => Promise.resolve('idle'),
  list: () => Promise.resolve({ queued: [], failed: [] }),
};
