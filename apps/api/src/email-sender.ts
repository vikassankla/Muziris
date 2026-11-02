import type { Database } from '@muziris/db';
import { sendDueEmails, type MailTransport } from '@muziris/notifications';
import type { Logger } from './logger.js';

/** How often the API looks for due emails (ADR 0020). */
export const EMAIL_SEND_INTERVAL_MS = 10_000;

/**
 * Sends due emails every interval, inside the API process, until stopped. Runs never overlap.
 * Logs counts, and the id and kind of an email that gave up: never recipients or bodies. When
 * the job runner arrives this loop moves into it unchanged.
 */
export function startEmailSender(deps: {
  db: Database;
  logger: Logger;
  transport: MailTransport;
  now?: () => Date;
  intervalMs?: number;
}): { stop: () => Promise<void> } {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  async function tick() {
    try {
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
    } catch (error) {
      deps.logger.error({ err: error }, 'emails.sender_failed');
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(() => {
        running = undefined;
        schedule();
      });
    }, deps.intervalMs ?? EMAIL_SEND_INTERVAL_MS);
    timer.unref();
  }

  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
