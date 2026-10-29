// Public interface of the visibility module. Other modules import only from here.
export { getBuildState, rebuildVisibility, type BuildResult, type BuildState } from './build.js';
export { VisibilityError, type VisibilityErrorCode } from './errors.js';
export { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from './page.js';
export {
  previewVisibility,
  visibilityPreviewQuerySchema,
  type ServingContext,
  type VisibilityPreview,
  type VisibilityPreviewQuery,
} from './preview.js';
export {
  listVisibleProducts,
  listVisibleProductsQuerySchema,
  visibleCategoryIds,
  visibleCategoryIdsForBuyer,
  visibleProductIds,
  visibleProductIdsForBuyer,
  type BuyerOnWebsite,
  type CustomerOnWebsite,
  type ListVisibleProductsQuery,
  type VisibleProductPage,
} from './read.js';
export {
  resolveCategoryVisibility,
  resolveProductVisibility,
  RULE_SUBJECTS,
  RULE_TARGETS,
  VISIBILITIES,
  type ApplicableRule,
  type RuleSubject,
  type RuleTarget,
  type Visibility,
  type VisibilityDecision,
  type VisibilityReason,
} from './resolve.js';
export {
  createRule,
  deleteRule,
  findRule,
  listRules,
  listRulesQuerySchema,
  newRuleSchema,
  ruleChangesSchema,
  updateRule,
  type ListRulesQuery,
  type NewRule,
  type Rule,
  type RuleChanges,
  type RulePage,
} from './rules.js';
