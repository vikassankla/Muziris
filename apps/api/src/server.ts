import { serve } from '@hono/node-server';
import { createDatabase } from '@muziris/db';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_MAX_CONNECTIONS,
  applicationName: 'muziris-api',
});

const app = createApp({
  logger,
  pingDatabase: database.ping,
  corsOrigins: env.CORS_ORIGINS,
  maxBodyBytes: env.MAX_BODY_BYTES,
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  logger.info({ port: info.port, host: env.HOST, nodeEnv: env.NODE_ENV }, 'API listening');
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
  await database.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
