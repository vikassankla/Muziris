/**
 * Resets an admin's second factor from the server (ADR 0026), for a sole administrator who has
 * lost their phone and their recovery codes. Their sessions end, and they enrol again at their
 * next sign-in. Anyone who can run this already holds the database credentials.
 *
 *   pnpm --filter @muziris/api admin:reset-2fa --email asha@acme.example
 */
import { parseArgs } from 'node:util';
import { createDatabase } from '@muziris/db';
import { findUserByEmail, resetTwoFactor } from '@muziris/identity';
import { loadEnv } from '../env.js';

const { values } = parseArgs({ options: { email: { type: 'string' } } });
if (!values.email) {
  process.stderr.write('Usage: admin:reset-2fa --email <email>\n');
  process.exit(2);
}

const env = loadEnv();
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
});
try {
  const user = await findUserByEmail(database.db, 'admin', values.email);
  if (!user) throw new Error('No admin with that email');
  const hadFactor = await resetTwoFactor(database.db, user.id, new Date());
  process.stdout.write(
    hadFactor
      ? `Reset two-factor sign-in for ${user.email} (${user.id}). They enrol again at their next sign-in.\n`
      : `${user.email} (${user.id}) had no two-factor sign-in set up. Their sessions have ended.\n`,
  );
} catch (error) {
  process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
