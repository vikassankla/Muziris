// The fallback rule of ADR 0012, written once in plain code. The admin preview uses it to explain
// a decision, and the known-answer tests run the same tables through it and through the
// set-based build, so the SQL and this description cannot drift apart unnoticed.

/** Who a rule is for on a website, most specific first: the order the levels are tried in. */
export const RULE_TARGETS = ['customer', 'customer_group', 'website'] as const;
export type RuleTarget = (typeof RULE_TARGETS)[number];

/** What a rule is about. */
export const RULE_SUBJECTS = ['product', 'category'] as const;
export type RuleSubject = (typeof RULE_SUBJECTS)[number];

export const VISIBILITIES = ['visible', 'hidden'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** A rule that applies to the buyer at its level: the buyer's customer, group or website. */
export interface ApplicableRule {
  id: string;
  target: RuleTarget;
  subject: RuleSubject;
  subjectId: string;
  visibility: Visibility;
}

/**
 * Why a product or category is visible or not: `disabled` (a disabled product, never visible),
 * `rule` (the rule in `rule` decided), or `default` (no rule applies, so it is visible).
 */
export type VisibilityReason = 'disabled' | 'rule' | 'default';

export interface VisibilityDecision<R extends ApplicableRule = ApplicableRule> {
  visible: boolean;
  reason: VisibilityReason;
  rule: R | null;
  /** For a category rule: how many levels above the subject's own category it sits (0 = own). */
  categoryDistance: number | null;
}

/**
 * Tries the levels in order (customer, customer group, website); within a level, a rule on the
 * product itself, then on each category of `categoryPath`, nearest first. The first rule found
 * decides; with none, the subject is visible.
 */
function decide<R extends ApplicableRule>(
  rules: readonly R[],
  productId: string | null,
  categoryPath: readonly string[],
): VisibilityDecision<R> {
  for (const level of RULE_TARGETS) {
    const atLevel = rules.filter((r) => r.target === level);
    if (productId !== null) {
      const own = atLevel.find((r) => r.subject === 'product' && r.subjectId === productId);
      if (own) return decided(own, null);
    }
    for (const [distance, categoryId] of categoryPath.entries()) {
      const rule = atLevel.find((r) => r.subject === 'category' && r.subjectId === categoryId);
      if (rule) return decided(rule, distance);
    }
  }
  return { visible: true, reason: 'default', rule: null, categoryDistance: null };
}

function decided<R extends ApplicableRule>(
  rule: R,
  categoryDistance: number | null,
): VisibilityDecision<R> {
  return { visible: rule.visibility === 'visible', reason: 'rule', rule, categoryDistance };
}

/**
 * Whether a product is visible to a buyer. `categoryPath` is the product's category and every
 * category above it, nearest first (empty for a product without a category). `rules` are the
 * rules on the website for the buyer's customer, its customer group and the website.
 */
export function resolveProductVisibility<R extends ApplicableRule>(input: {
  productId: string;
  enabled: boolean;
  categoryPath: readonly string[];
  rules: readonly R[];
}): VisibilityDecision<R> {
  if (!input.enabled) {
    return { visible: false, reason: 'disabled', rule: null, categoryDistance: null };
  }
  return decide(input.rules, input.productId, input.categoryPath);
}

/**
 * Whether a category is visible to a buyer. `categoryPath` is the category itself and every
 * category above it, nearest first.
 */
export function resolveCategoryVisibility<R extends ApplicableRule>(input: {
  categoryPath: readonly string[];
  rules: readonly R[];
}): VisibilityDecision<R> {
  return decide(input.rules, null, input.categoryPath);
}
