// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { compileOperations, sha256 } from './codegen.js';
import {
  compileFromDisk,
  GENERATED_FILE,
  REGISTRY_FILE,
  registryText,
  SCHEMA_FILE,
} from './operations.js';

describe('the committed operations', () => {
  it('match what pnpm operations writes, so the API runs exactly what the app sends', async () => {
    const compiled = await compileFromDisk();
    expect(await readFile(GENERATED_FILE, 'utf8')).toBe(compiled.typescript);
    expect(await readFile(REGISTRY_FILE, 'utf8')).toBe(registryText(compiled.registry));
  });

  it('key every document by the SHA-256 of its exact text', async () => {
    const registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as Record<string, string>;
    expect(Object.keys(registry)).toHaveLength(5);
    for (const [hash, text] of Object.entries(registry)) expect(sha256(text)).toBe(hash);
  });

  it('put no document text in generated.ts, only names and hashes', async () => {
    const generated = await readFile(GENERATED_FILE, 'utf8');
    expect(generated).not.toMatch(/query \w+/);
    expect(generated).toMatch(/hash: '[0-9a-f]{64}'/);
  });
});

describe('compileOperations', () => {
  const schema = readFile(SCHEMA_FILE, 'utf8');
  const compile = async (file: string, text: string) =>
    compileOperations(await schema, [{ file, text }]);

  it('types variables and results, with null for nullable fields and readonly lists', async () => {
    const { typescript } = await compile(
      'One.graphql',
      'query One($sku: String!) { product(sku: $sku) { sku units { code precision } } }',
    );
    expect(typescript).toContain('export interface OneVariables');
    expect(typescript).toContain('sku: string;');
    expect(typescript).toMatch(/product: \{[^}]*sku: string;/s);
    expect(typescript).toMatch(/\} \| null;/);
    expect(typescript).toMatch(/units: readonly \{/);
    expect(typescript).toContain('precision: number;');
  });

  it.each<[string, string, RegExp]>([
    ['Bad.graphql', 'query Bad { nope }', /Cannot query field "nope"/],
    ['Named.graphql', 'query Other { website { code } }', /name the operation Named/],
    [
      'Two.graphql',
      'query Two { website { code } } query Three { website { code } }',
      /exactly one/,
    ],
    [
      'Frag.graphql',
      'query Frag { website { ...W } } fragment W on Website { code }',
      /exactly one|fragments/,
    ],
  ])('rejects %s', async (file, text, message) => {
    await expect(compile(file, text)).rejects.toThrow(message);
  });
});
