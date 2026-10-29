/**
 * Rebuilds what every buyer may see from the visibility rules and the catalog, with the same
 * set-based build as the admin action (ADR 0012). For installs and scripts, and after catalog
 * changes, until the job runner runs builds on its own.
 *
 *   pnpm --filter @muziris/api visibility:build
 */
import { createDatabase } from '@muziris/db';
import { rebuildVisibility } from '@muziris/visibility';
import { loadEnv } from '../env.js';

const env = loadEnv();
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
  // The build raises its own statement timeout inside its transaction.
});
try {
  const result = await rebuildVisibility(database.db);
  process.stdout.write(
    `Built ${result.contextCount} visibility contexts with ${result.visibleProductCount} ` +
      `visible products and ${result.visibleCategoryCount} visible categories in ` +
      `${result.buildMs} ms\n`,
  );
} catch (error) {
  process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
