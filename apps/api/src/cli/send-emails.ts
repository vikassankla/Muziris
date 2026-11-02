/**
 * Sends the emails that are due now, once (ADR 0020). The API sends them every ten seconds on
 * its own; this is for scripts, and for checking the mail setup.
 *
 *   pnpm --filter @muziris/api notifications:send
 */
import { createDatabase } from '@muziris/db';
import { sendDueEmails, smtpTransport } from '@muziris/notifications';
import { loadEnv } from '../env.js';

const env = loadEnv();
if (env.mail.smtpUrl === undefined) {
  process.stderr.write('SMTP_URL is not set; nothing was sent\n');
  process.exit(1);
}
const transport = smtpTransport(env.mail.smtpUrl, env.mail.from);
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
});
try {
  const result = await sendDueEmails(database.db, transport, new Date(), { limit: 500 });
  process.stdout.write(
    `Sent ${result.sent}, retrying ${result.retrying}, gave up on ${result.failed.length}\n`,
  );
} catch (error) {
  process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  transport.close();
  await database.close();
}
