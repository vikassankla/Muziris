/**
 * Writes the storefront GraphQL schema to src/storefront/schema.graphql, the file clients
 * generate typed code from (ADR 0014, FR-SF-7). A test fails while the file is out of date.
 *
 *   pnpm --filter @muziris/api storefront:schema
 */
import { writeFile } from 'node:fs/promises';
import { printSchema } from 'graphql';
import { storefrontSchema } from '../storefront/schema.js';

const path = new URL('../storefront/schema.graphql', import.meta.url);
await writeFile(path, `${printSchema(storefrontSchema)}\n`);
process.stdout.write(`Wrote ${path.pathname}\n`);
