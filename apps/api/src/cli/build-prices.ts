/**
 * Rebuilds every combined price list from the price lists and assignments, with the same
 * set-based build the `pricing.build` job runs (ADR 0011, 0025). For installs and scripts: it runs
 * at once, in this process, without the job runner.
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
