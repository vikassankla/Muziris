import {
  scopeChain,
  type ScopeContext,
  type ScopeType,
  type SettingDefinition,
} from './definitions.js';

/** A value as stored in the database for one scope. */
export interface StoredValue {
  key: string;
  scopeType: ScopeType;
  scopeId: string | null;
  value: unknown;
}

export interface ResolvedSetting<T> {
  value: T;
  /** Where the value came from, so the admin can show "inherited from website". */
  source: ScopeType | 'default';
}

export class InvalidStoredSettingError extends Error {
  readonly key: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;

  constructor(key: string, scopeType: ScopeType, scopeId: string | null) {
    super(`Stored value for "${key}" at ${scopeType} scope does not match its schema`);
    this.name = 'InvalidStoredSettingError';
    this.key = key;
    this.scopeType = scopeType;
    this.scopeId = scopeId;
  }
}

/**
 * Pure resolution: given every stored value for the key across scopes, returns the most
 * specific one that applies to the context, or the default. Values at scopes the definition
 * does not allow are ignored, so a stale row can never override policy.
 */
export function resolveSetting<T>(
  definition: SettingDefinition<T>,
  stored: readonly StoredValue[],
  context: ScopeContext,
): ResolvedSetting<T> {
  for (const scope of scopeChain(context)) {
    if (!definition.allowedScopes.includes(scope.type)) continue;
    const scopeId = scope.type === 'global' ? null : scope.id;
    const match = stored.find(
      (row) =>
        row.key === definition.key && row.scopeType === scope.type && row.scopeId === scopeId,
    );
    if (!match) continue;
    const parsed = definition.schema.safeParse(match.value);
    if (!parsed.success) {
      // Fail loudly: silently falling back could change prices or permissions unnoticed.
      throw new InvalidStoredSettingError(definition.key, scope.type, scopeId);
    }
    return { value: parsed.data, source: scope.type };
  }
  return { value: definition.defaultValue, source: 'default' };
}
