/**
 * Rebuilds every combined price list from the price lists and assignments, with the same
 * set-based build as the admin action (ADR 0011). For installs and scripts, until the job runner
 * runs builds on its own.
 *
 *   pnpm --filter @muziris/api pricing:build
 */
import { createDatabase } from '@muziris/db';
import { rebuildCombinedPrices } from '@muziris/pricing';
import { loadEnv } from '../env.js';

const env = loadEnv();
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
  // The build raises its own statement timeout inside its transaction.
});
try {
  const result = await rebuildCombinedPrices(database.db);
  process.stdout.write(
    `Built ${result.combinedPriceListCount} combined price lists with ` +
      `${result.combinedPriceCount} prices in ${result.buildMs} ms\n`,
  );
} catch (error) {
  process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
