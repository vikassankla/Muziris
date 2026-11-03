/**
 * Adds the MRO demo catalog to one website (demo-catalog.ts): categories, products with HSN codes,
 * and a list price with quantity breaks, then builds prices, visibility and search. Running it
 * again changes nothing. It adds no tax rates or registrations: enter those on System > Tax.
 *
 *   pnpm --filter @muziris/api run demo:seed --website main
 */
import { parseArgs } from 'node:util';
import { createDatabase } from '@muziris/db';
import { DemoSeedError, seedDemoCatalog } from '../demo-catalog.js';
import { loadEnv } from '../env.js';

const { values } = parseArgs({ options: { website: { type: 'string', default: 'main' } } });

const env = loadEnv();
const database = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: 1,
  applicationName: 'muziris-cli',
});
try {
  const result = await seedDemoCatalog(database.db, { websiteCode: values.website });
  process.stdout.write(
    `Demo catalog on ${result.websiteName} (${result.currency}): added ${result.categoriesAdded} ` +
      `categories, ${result.productsAdded} products and ${result.pricesAdded} prices\n` +
      `Buyers can now see ${result.visibleProductCount} products in the last visibility build\n` +
      'Next: check System > Tax, since checkout needs your tax registration and rates\n',
  );
} catch (error) {
  process.stderr.write(
    error instanceof DemoSeedError
      ? `${error.message}\n`
      : `Failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
