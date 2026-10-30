/**
 * A persisted operation (ADR 0015): its name and the hash the API knows it by. The result and
 * variables types ride along for the type checker only; generated.ts declares one per
 * operation in src/operations.
 */
export interface Operation<TResult, TVariables> {
  readonly name: string;
  readonly hash: string;
  readonly types?: { result: TResult; variables: TVariables };
}
