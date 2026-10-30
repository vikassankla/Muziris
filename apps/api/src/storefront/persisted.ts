import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

// Persisted queries (ADR 0014, FR-SF-2): documents registered ahead of time by the hash of their
// text. The registry is a JSON object of hash to document, produced by the storefront's build.
// A request that names an unknown hash is refused; nothing is ever registered on a miss.

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export type PersistedQueries = ReadonlyMap<string, string>;

/** The hash a client sends for a document: SHA-256 of its exact text, in lower-case hex. */
export function queryHash(document: string): string {
  return createHash('sha256').update(document, 'utf8').digest('hex');
}

const registrySchema = z.record(z.string().regex(SHA256_HEX), z.string().min(1).max(20_000));

/**
 * Checks a registry: every key must be the hash of its document, so a registry that was edited
 * by hand or built from other text cannot run something other than what it claims.
 */
export function persistedQueriesFrom(value: unknown): PersistedQueries {
  const registry = registrySchema.parse(value);
  const queries = new Map<string, string>();
  for (const [hash, document] of Object.entries(registry)) {
    if (queryHash(document) !== hash) {
      throw new Error(`Persisted query ${hash} does not match the hash of its text`);
    }
    queries.set(hash, document);
  }
  return queries;
}

/** Reads and checks a registry file. Without a path there are no persisted queries. */
export async function loadPersistedQueries(path: string | undefined): Promise<PersistedQueries> {
  if (path === undefined) return new Map();
  const text = await readFile(path, 'utf8');
  return persistedQueriesFrom(JSON.parse(text) as unknown);
}
