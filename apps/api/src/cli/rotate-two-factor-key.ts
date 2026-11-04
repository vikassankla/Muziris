/**
 * Re-encrypts every admin's two-factor secret under a new ADMIN_TOTP_KEY (ADR 0026), in one
 * transaction. Both keys come from the environment only, never the command line:
 *
 *   ADMIN_TOTP_KEY_PREVIOUS=<old key> ADMIN_TOTP_KEY=<new key> \
 *     pnpm --filter @muziris/api admin:rotate-2fa-key
 *
 * Stop the API and any worker first, and start them with the new key afterwards.
 */
import { createDatabase } from '@muziris/db';
import { parseTotpKey, rotateTwoFactorKey } from '@muziris/identity';
import { loadEnv } from '../env.js';

const env = loadEnv();
const previous = process.env['ADMIN_TOTP_KEY_PREVIOUS'];
if (!previous || !env.twoFactorKey) {
  process.stderr.write(
    'Set ADMIN_TOTP_KEY_PREVIOUS to the old key and ADMIN_TOTP_KEY to the new one\n',
  );
  process.exit(2);
}
let oldKey;
try {
  oldKey = parseTotpKey(previous);
} catch {
  process.stderr.write('ADMIN_TOTP_KEY_PREVIOUS must be 32 bytes in base64\n');
  process.exit(2);
}
if (oldKey.bytes.equals(env.twoFactorKey.bytes)) {
  process.stderr.write('The old and new keys are the same\n');
  process.exit(2);
}

const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
});
try {
  const count = await rotateTwoFactorKey(database.db, oldKey, env.twoFactorKey);
  process.stdout.write(`Re-encrypted ${count} two-factor secrets under the new key\n`);
} catch (error) {
  // A wrong old key fails to decrypt; nothing was changed.
  process.stderr.write(
    `Failed, nothing changed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
