import type { Database } from '@muziris/db';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { configValues } from '../db/schema.js';
import {
  scopeChain,
  type Scope,
  type ScopeContext,
  type SettingDefinition,
} from './definitions.js';
import { resolveSetting, type ResolvedSetting, type StoredValue } from './resolve.js';

export class SettingScopeNotAllowedError extends Error {
  constructor(key: string, scope: Scope['type']) {
    super(`Setting "${key}" cannot be set at ${scope} scope`);
    this.name = 'SettingScopeNotAllowedError';
  }
}

function scopeCondition(scope: Scope): SQL {
  const condition =
    scope.type === 'global'
      ? and(eq(configValues.scopeType, 'global'), isNull(configValues.scopeId))
      : and(eq(configValues.scopeType, scope.type), eq(configValues.scopeId, scope.id));
  // `and` only returns undefined for an empty list; match nothing rather than everything.
  return condition ?? sql`false`;
}

/** Loads every stored value for the given keys that could apply to the context, in one query. */
export async function loadStoredValues(
  db: Database,
  keys: readonly string[],
  context: ScopeContext,
): Promise<StoredValue[]> {
  if (keys.length === 0) return [];
  const chain = scopeChain(context);
  return db
    .select({
      key: configValues.key,
      scopeType: configValues.scopeType,
      scopeId: configValues.scopeId,
      value: configValues.value,
    })
    .from(configValues)
    .where(and(inArray(configValues.key, [...keys]), or(...chain.map(scopeCondition))));
}

export async function getSetting<T>(
  db: Database,
  definition: SettingDefinition<T>,
  context: ScopeContext,
): Promise<ResolvedSetting<T>> {
  const stored = await loadStoredValues(db, [definition.key], context);
  return resolveSetting(definition, stored, context);
}

/** Validates and stores a value at one scope, replacing any existing value there. */
export async function setSetting<T>(
  db: Database,
  definition: SettingDefinition<T>,
  scope: Scope,
  value: T,
): Promise<void> {
  if (!definition.allowedScopes.includes(scope.type)) {
    throw new SettingScopeNotAllowedError(definition.key, scope.type);
  }
  const parsed = definition.schema.parse(value);
  await db
    .insert(configValues)
    .values({
      scopeType: scope.type,
      scopeId: scope.type === 'global' ? null : scope.id,
      key: definition.key,
      value: parsed,
    })
    .onConflictDoUpdate({
      target: [configValues.scopeType, configValues.scopeId, configValues.key],
      set: { value: parsed, updatedAt: sql`now()` },
    });
}

/** Removes the value at one scope so the setting inherits from the next scope up. */
export async function clearSetting(
  db: Database,
  definition: SettingDefinition<unknown>,
  scope: Scope,
): Promise<void> {
  await db
    .delete(configValues)
    .where(and(eq(configValues.key, definition.key), scopeCondition(scope)));
}
