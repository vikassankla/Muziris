import { serve } from '@hono/node-server';
import { createDatabase } from '@muziris/db';
import { smtpTransport } from '@muziris/notifications';
import { createGatewayClients } from '@muziris/payments';
import { tableTaxProvider } from '@muziris/tax';
import { startJobRunner } from '@muziris/jobs';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { jobHandlers } from './jobs.js';
import { createLogger } from './logger.js';
import { loadPersistedQueries } from './storefront/persisted.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_MAX_CONNECTIONS,
  applicationName: 'muziris-api',
});

// A registry whose entries do not match their hashes stops the API here (ADR 0014).
const persistedQueries = await loadPersistedQueries(env.STOREFRONT_PERSISTED_QUERIES);

// Emails are queued with their changes and sent by the notifications.send job (ADR 0020, 0025).
// Without SMTP_URL they wait in the outbox until it is set.
const transport =
  env.mail.smtpUrl === undefined ? undefined : smtpTransport(env.mail.smtpUrl, env.mail.from);
if (!transport && env.JOB_WORKERS)
  logger.warn('SMTP_URL is not set; emails are queued but not sent');

// The job runner (ADR 0025). By default this process runs the workers too; with
// JOB_WORKERS=false it only enqueues, and `pnpm --filter @muziris/api worker` runs them.
const jobs = await startJobRunner({
  url: env.DATABASE_URL,
  logger,
  ...(env.JOB_WORKERS
    ? { handlers: jobHandlers({ db: database.db, logger, ...(transport ? { transport } : {}) }) }
    : {}),
});

const app = createApp({
  jobs: jobs.queue,
  logger,
  db: database.db,
  pingDatabase: database.ping,
  corsOrigins: env.CORS_ORIGINS,
  maxBodyBytes: env.MAX_BODY_BYTES,
  trustedProxyHops: env.TRUSTED_PROXY_HOPS,
  // GST and US sales tax from the tax tables; a missing code, rate or registration refuses.
  tax: tableTaxProvider(database.db),
  // Stripe and Razorpay when their keys are set; terms only otherwise (ADR 0019).
  payments: { gateways: env.payments, clients: createGatewayClients(env.payments) },
  storefront: {
    persistedQueries,
    allowAdhocQueries: env.STOREFRONT_ADHOC_QUERIES === 'allow',
  },
  mail: env.mail,
  storefrontWebsite: env.STOREFRONT_WEBSITE,
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  logger.info(
    {
      port: info.port,
      host: env.HOST,
      nodeEnv: env.NODE_ENV,
      paymentGateways: Object.keys(env.payments),
      jobWorkers: env.JOB_WORKERS,
      emailSending: transport !== undefined,
    },
    'API listening',
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // Stop accepting connections, let in-flight requests finish, then release the database.
  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
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
