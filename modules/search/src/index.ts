// Public interface of the search module. Other modules import only from here.
export {
  getBuildState,
  indexProducts,
  indexProductsInCategory,
  rebuildSearchIndex,
  type BuildResult,
  type BuildState,
} from './build.js';
export {
  adminSearchQuerySchema,
  MAX_QUERY_LENGTH,
  MAX_QUERY_WORDS,
  MAX_RESULTS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  parseQuery,
  searchQuerySchema,
  type AdminSearchQuery,
  type ParsedQuery,
  type SearchQuery,
} from './query.js';
export {
  CLOSE_MATCH_THRESHOLD,
  MATCHES,
  searchProducts,
  searchProductsForBuyer,
  type AdminSearchHit,
  type Match,
  type SearchHit,
  type SearchPage,
} from './search.js';
