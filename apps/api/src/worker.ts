/**
 * Runs the job workers on their own, for installs that set JOB_WORKERS=false on the API so web
 * and jobs scale apart (ADR 0025).
 *
 *   pnpm --filter @muziris/api worker
 *
 * It answers /health/live on WORKER_PORT, and nothing else.
 */
import { serve } from '@hono/node-server';
import { createDatabase } from '@muziris/db';
import { startJobRunner } from '@muziris/jobs';
import { smtpTransport } from '@muziris/notifications';
import { Hono } from 'hono';
import { loadEnv } from './env.js';
import { jobHandlers } from './jobs.js';
import { createLogger } from './logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_MAX_CONNECTIONS,
  applicationName: 'muziris-worker',
});
const transport =
  env.mail.smtpUrl === undefined ? undefined : smtpTransport(env.mail.smtpUrl, env.mail.from);
if (!transport) logger.warn('SMTP_URL is not set; emails are queued but not sent');

const jobs = await startJobRunner({
  url: env.DATABASE_URL,
  logger,
  handlers: jobHandlers({ db: database.db, logger, ...(transport ? { transport } : {}) }),
});

const health = new Hono();
health.get('/health/live', (c) => c.json({ status: 'ok', process: 'worker' }));
const server = serve({ fetch: health.fetch, port: env.WORKER_PORT, hostname: env.HOST }, (info) => {
  logger.info({ port: info.port, host: env.HOST, process: 'worker' }, 'worker running');
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, process: 'worker' }, 'shutting down');
  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, 30_000);
  forceExit.unref();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  // Lets a running job finish before the database closes.
  await jobs.stop();
  transport?.close();
  await database.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
