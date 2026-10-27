// Public interface of the platform module. Other modules import only from here.
export {
  defineFeature,
  defineSetting,
  SCOPE_PRECEDENCE,
  scopeChain,
  type Scope,
  type ScopeContext,
  type ScopeType,
  type SettingDefinition,
} from './settings/definitions.js';
export {
  InvalidStoredSettingError,
  resolveSetting,
  type ResolvedSetting,
  type StoredValue,
} from './settings/resolve.js';
export {
  clearSetting,
  getSetting,
  loadStoredValues,
  setSetting,
  SettingScopeNotAllowedError,
} from './settings/store.js';
export {
  createOrganization,
  createWebsite,
  findWebsiteByCode,
  listWebsites,
  newWebsiteSchema,
  type NewWebsite,
  type Organization,
  type Website,
} from './websites.js';
