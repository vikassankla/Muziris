import registry from '../../persisted-queries.json' with { type: 'json' };

/** The hashes in the persisted query registry the API loads. */
export const REGISTRY_HASHES: readonly string[] = Object.keys(registry);
