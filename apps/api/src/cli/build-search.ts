/**
 * Rebuilds the product search index from the catalog, with the same set-based build as the
 * `search.build` job (ADR 0013, 0025). For installs and scripts, and after catalog changes made
 * outside the admin API: it runs at once, in this process, without the job runner.
 *
 *   pnpm --filter @muziris/api search:build
 */
import { createDatabase } from '@muziris/db';
import { rebuildSearchIndex } from '@muziris/search';
import { loadEnv } from '../env.js';

const env = loadEnv();
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
  // The build raises its own statement timeout inside its transaction.
});
try {
  const result = await rebuildSearchIndex(database.db);
  process.stdout.write(`Indexed ${result.productCount} products in ${result.buildMs} ms\n`);
} catch (error) {
  process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
