import {
  getNamedType,
  getNullableType,
  GraphQLError,
  isCompositeType,
  isListType,
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';

// Limits checked before a query runs (ADR 0014, FR-SF-3). The document has already passed
// graphql-js validation, so every field exists and fragments do not form cycles.

export const MAX_DOCUMENT_LENGTH = 20_000;
export const MAX_DEPTH = 8;
export const MAX_COST = 2_500;

/**
 * How many items a list field is expected to return, for the cost. A list inside a page whose
 * field takes `first` uses it (or its default); a list without one declares
 * `extensions.listSize`.
 */
export interface FieldCostExtensions {
  listSize?: number;
}

export interface Measure {
  depth: number;
  cost: number;
}

function intValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  if (node.kind === Kind.INT) return Number(node.value);
  if (node.kind === Kind.VARIABLE) return variables[node.name.value];
  return undefined;
}

/**
 * Measures an operation: its depth (levels of fields, through fragments) and its cost (every
 * field 1, times the number of times it is expected to run). `__typename` and introspection
 * fields cost nothing extra but count for depth.
 */
export function measure(
  schema: GraphQLSchema,
  document: DocumentNode,
  operation: OperationDefinitionNode,
  variables: Readonly<Record<string, unknown>>,
): Measure {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const root = schema.getRootType(operation.operation);
  if (!root) return { depth: 0, cost: 0 };

  /**
   * `times` is how often each field of this selection runs. `page` is the `first` of the field
   * above, waiting for the list field below it (a page's `nodes`) to use as its item count.
   */
  const walk = (
    selectionSet: SelectionSetNode,
    parent: GraphQLCompositeType,
    level: number,
    times: number,
    page: number | undefined,
  ): Measure => {
    let depth = level;
    let cost = 0;
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        const field =
          'getFields' in parent && !name.startsWith('__') ? parent.getFields()[name] : undefined;
        cost += name.startsWith('__') ? 0 : times;
        depth = Math.max(depth, level + 1);
        if (!selection.selectionSet) continue;
        let childTimes = times;
        let childPage: number | undefined;
        if (field) {
          const first = field.args.find((a) => a.name === 'first');
          if (first) {
            const given = selection.arguments?.find((a) => a.name.value === 'first');
            const value = given ? intValue(given.value, variables) : first.default?.value;
            childPage =
              typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
          } else if (isListType(getNullableType(field.type))) {
            const extensions = field.extensions as FieldCostExtensions | undefined;
            childTimes = times * (page ?? extensions?.listSize ?? 1);
          }
        }
        const type = field ? getNamedType(field.type) : undefined;
        const inner =
          type && isCompositeType(type)
            ? walk(selection.selectionSet, type, level + 1, childTimes, childPage)
            : { depth: level + 2, cost: 0 };
        depth = Math.max(depth, inner.depth);
        cost += inner.cost;
      } else {
        const fragment =
          selection.kind === Kind.INLINE_FRAGMENT ? selection : fragments.get(selection.name.value);
        if (!fragment) continue;
        const condition = fragment.typeCondition
          ? schema.getType(fragment.typeCondition.name.value)
          : parent;
        const type = condition && isCompositeType(condition) ? condition : parent;
        const inner = walk(fragment.selectionSet, type, level, times, page);
        depth = Math.max(depth, inner.depth);
        cost += inner.cost;
      }
    }
    return { depth, cost };
  };

  return walk(operation.selectionSet, root, 0, 1, undefined);
}

/** The errors for an operation over its limits, empty when it is within them. */
export function limitErrors(found: Measure): GraphQLError[] {
  const errors: GraphQLError[] = [];
  if (found.depth > MAX_DEPTH) {
    errors.push(
      new GraphQLError(
        `The query is ${found.depth} levels deep; at most ${MAX_DEPTH} are allowed`,
        {
          extensions: { code: 'QUERY_TOO_DEEP', limit: MAX_DEPTH, measured: found.depth },
        },
      ),
    );
  }
  if (found.cost > MAX_COST) {
    errors.push(
      new GraphQLError(`The query costs ${found.cost}; at most ${MAX_COST} is allowed`, {
        extensions: { code: 'QUERY_TOO_COSTLY', limit: MAX_COST, measured: found.cost },
      }),
    );
  }
  return errors;
}
