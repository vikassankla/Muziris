import { createHash } from 'node:crypto';
import {
  buildSchema,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  parse,
  print,
  typeFromAST,
  validate,
  type GraphQLFieldMap,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLType,
  type SelectionSetNode,
} from 'graphql';

// The storefront's operation compiler (ADR 0015). Each src/operations/<Name>.graphql holds one
// named query. This checks it against the committed storefront schema, prints it in graphql-js's
// canonical form, hashes that text as the API does (persisted.ts), and writes TypeScript types
// for its variables and result. Fragments are not supported: the operations are few and small.

export interface OperationSource {
  /** The file name, `Products.graphql`; the operation must be named after it. */
  file: string;
  text: string;
}

export interface Compiled {
  /** The contents of src/operations/generated.ts. */
  typescript: string;
  /** The persisted query registry: hash to document, in operation name order. */
  registry: Record<string, string>;
}

const SCALARS: Readonly<Record<string, string>> = {
  ID: 'string',
  String: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean',
};

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function scalarOrEnum(type: GraphQLType, where: string): string {
  if (isScalarType(type)) {
    const mapped = SCALARS[type.name];
    if (mapped === undefined)
      throw new Error(`${where}: no TypeScript type for scalar ${type.name}`);
    return mapped;
  }
  if (isEnumType(type)) {
    return type
      .getValues()
      .map((v) => `'${v.name}'`)
      .join(' | ');
  }
  throw new Error(`${where}: ${String(type)} is not a scalar or an enum`);
}

function pad(depth: number): string {
  return '  '.repeat(depth);
}

/** The TypeScript type of a field's value, for the fields selected on it. */
function outputType(
  type: GraphQLOutputType,
  selection: SelectionSetNode | undefined,
  depth: number,
  where: string,
): string {
  if (isNonNullType(type)) return nonNull(type.ofType, selection, depth, where);
  return `${nonNull(type, selection, depth, where)} | null`;
}

function nonNull(
  type: GraphQLOutputType,
  selection: SelectionSetNode | undefined,
  depth: number,
  where: string,
): string {
  if (isNonNullType(type)) return nonNull(type.ofType, selection, depth, where);
  if (isListType(type)) {
    const item = outputType(type.ofType, selection, depth, where);
    return item.includes('|') ? `readonly (${item})[]` : `readonly ${item}[]`;
  }
  if (isObjectType(type)) {
    if (!selection) throw new Error(`${where}: ${type.name} needs a selection`);
    return objectType(type.getFields(), selection, depth, where);
  }
  return scalarOrEnum(type, where);
}

function objectType(
  fields: GraphQLFieldMap<unknown, unknown>,
  selection: SelectionSetNode,
  depth: number,
  where: string,
): string {
  const lines: string[] = [];
  for (const node of selection.selections) {
    if (node.kind !== Kind.FIELD) throw new Error(`${where}: fragments are not supported`);
    const key = node.alias?.value ?? node.name.value;
    if (node.name.value === '__typename') {
      lines.push(`${pad(depth + 1)}${key}: string;`);
      continue;
    }
    const field = fields[node.name.value];
    if (!field) throw new Error(`${where}: unknown field ${node.name.value}`);
    lines.push(
      `${pad(depth + 1)}${key}: ${outputType(field.type, node.selectionSet, depth + 1, `${where}.${key}`)};`,
    );
  }
  return `{\n${lines.join('\n')}\n${pad(depth)}}`;
}

function inputType(type: GraphQLType, where: string): string {
  if (isNonNullType(type)) return inputType(type.ofType, where);
  if (isListType(type)) return `readonly ${inputType(type.ofType, where)}[]`;
  return scalarOrEnum(type, where);
}

/** Compiles every operation, in name order. Throws on the first one that is not valid. */
export function compileOperations(
  schemaText: string,
  sources: readonly OperationSource[],
): Compiled {
  const schema: GraphQLSchema = buildSchema(schemaText);
  const query = schema.getQueryType();
  if (!query) throw new Error('The schema has no Query type');
  const blocks: string[] = [];
  const registry: Record<string, string> = {};
  const sorted = [...sources].sort((a, b) => (a.file < b.file ? -1 : 1));

  for (const source of sorted) {
    const name = source.file.replace(/\.graphql$/, '');
    const document = parse(source.text);
    const errors = validate(schema, document);
    if (errors.length > 0) {
      throw new Error(`${source.file}: ${errors.map((e) => e.message).join('; ')}`);
    }
    const [operation, ...rest] = document.definitions;
    if (operation?.kind !== Kind.OPERATION_DEFINITION || rest.length > 0) {
      throw new Error(`${source.file}: hold exactly one operation and nothing else`);
    }
    if (operation.operation !== 'query') {
      throw new Error(`${source.file}: only queries are supported`);
    }
    if (operation.name?.value !== name) {
      throw new Error(`${source.file}: name the operation ${name}, after its file`);
    }

    const variables = (operation.variableDefinitions ?? []).map((definition) => {
      const key = definition.variable.name.value;
      const type = typeFromAST(schema, definition.type);
      if (!type) throw new Error(`${source.file}: unknown type for $${key}`);
      const ts = inputType(type, `${source.file} $${key}`);
      return isNonNullType(type) ? `  ${key}: ${ts};` : `  ${key}?: ${ts} | null;`;
    });
    const variablesType =
      variables.length === 0
        ? `export type ${name}Variables = Record<string, never>;`
        : `export interface ${name}Variables {\n${variables.join('\n')}\n}`;
    const result = objectType(query.getFields(), operation.selectionSet, 0, name);

    const text = print(document);
    const hash = sha256(text);
    registry[hash] = text;
    blocks.push(
      [
        variablesType,
        `export interface ${name}Result ${result}`,
        `export const ${name}: Operation<${name}Result, ${name}Variables> = {\n  name: '${name}',\n  hash: '${hash}',\n};`,
      ].join('\n\n'),
    );
  }

  const typescript = [
    '// Generated by `pnpm --filter @muziris/storefront operations` from src/operations/*.graphql',
    '// and apps/api/src/storefront/schema.graphql. Do not edit.',
    '',
    "import type { Operation } from '../lib/graphql.js';",
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
  return { typescript, registry };
}
