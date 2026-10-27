import { z } from 'zod';

/** Scopes from most specific to least specific. Resolution takes the first value found. */
export const SCOPE_PRECEDENCE = [
  'customer',
  'customer_group',
  'website',
  'organization',
  'global',
] as const;

export type ScopeType = (typeof SCOPE_PRECEDENCE)[number];

export type Scope = { type: 'global' } | { type: Exclude<ScopeType, 'global'>; id: string };

/** Who is asking: the identifiers known for the current request. Missing ones are skipped. */
export interface ScopeContext {
  organizationId?: string;
  websiteId?: string;
  customerGroupId?: string;
  customerId?: string;
}

export interface SettingDefinition<T> {
  /** Namespaced key, for example "checkout.guest_enabled". */
  readonly key: string;
  readonly description: string;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  /** Scopes at which an admin may set this value. */
  readonly allowedScopes: readonly ScopeType[];
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function defineSetting<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  if (!KEY_PATTERN.test(definition.key)) {
    throw new TypeError(`Setting key "${definition.key}" must look like "area.name"`);
  }
  if (definition.allowedScopes.length === 0) {
    throw new TypeError(`Setting "${definition.key}" must allow at least one scope`);
  }
  // A default that fails its own schema is a programming error; catch it at startup.
  definition.schema.parse(definition.defaultValue);
  return Object.freeze({ ...definition, allowedScopes: [...definition.allowedScopes] });
}

/** A feature toggle is a boolean setting that can be switched at any scope. */
export function defineFeature(
  key: string,
  description: string,
  enabledByDefault: boolean,
): SettingDefinition<boolean> {
  return defineSetting({
    key,
    description,
    schema: z.boolean(),
    defaultValue: enabledByDefault,
    allowedScopes: SCOPE_PRECEDENCE,
  });
}

/** Turns a request context into the ordered scope chain to search. */
export function scopeChain(context: ScopeContext): Scope[] {
  const chain: Scope[] = [];
  if (context.customerId) chain.push({ type: 'customer', id: context.customerId });
  if (context.customerGroupId) chain.push({ type: 'customer_group', id: context.customerGroupId });
  if (context.websiteId) chain.push({ type: 'website', id: context.websiteId });
  if (context.organizationId) chain.push({ type: 'organization', id: context.organizationId });
  chain.push({ type: 'global' });
  return chain;
}
