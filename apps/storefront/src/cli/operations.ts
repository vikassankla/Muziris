import { readdir, readFile, writeFile } from 'node:fs/promises';
import { compileOperations, type Compiled } from './codegen.js';

// pnpm --filter @muziris/storefront operations: compiles src/operations/*.graphql into
// src/operations/generated.ts and the persisted query registry the API loads (ADR 0015).

export const SCHEMA_FILE = new URL('../../../api/src/storefront/schema.graphql', import.meta.url);
export const OPERATIONS_DIR = new URL('../operations/', import.meta.url);
export const GENERATED_FILE = new URL('../operations/generated.ts', import.meta.url);
export const REGISTRY_FILE = new URL('../../persisted-queries.json', import.meta.url);

/** Compiles the operations on disk, without writing anything. */
export async function compileFromDisk(): Promise<Compiled> {
  const schema = await readFile(SCHEMA_FILE, 'utf8');
  const files = (await readdir(OPERATIONS_DIR)).filter((f) => f.endsWith('.graphql'));
  const sources = await Promise.all(
    files.map(async (file) => ({
      file,
      text: await readFile(new URL(file, OPERATIONS_DIR), 'utf8'),
    })),
  );
  return compileOperations(schema, sources);
}

export function registryText(registry: Compiled['registry']): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const compiled = await compileFromDisk();
  await writeFile(GENERATED_FILE, compiled.typescript);
  await writeFile(REGISTRY_FILE, registryText(compiled.registry));
  process.stdout.write(
    `Wrote ${Object.keys(compiled.registry).length} operations to generated.ts and persisted-queries.json\n`,
  );
}
