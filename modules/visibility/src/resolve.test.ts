import { describe, expect, it } from 'vitest';
import {
  resolveCategoryVisibility,
  resolveProductVisibility,
  type ApplicableRule,
  type VisibilityDecision,
} from './resolve.js';
import {
  CATEGORY_CASES,
  categoryPathOf,
  FALLBACK_CASES,
  INHERITANCE_CASES,
  type CategoryCase,
  type DecidedBy,
  type ProductCase,
  type RuleSpec,
} from './test/known-answers.js';

const PRODUCT_ID = 'product';

/**
 * The rules that reach the case's customer: its own, its group's (when it is in the group) and
 * the website's. Choosing them is the caller's job (the build and the preview do it in SQL), so
 * rules for other customers, groups and websites are dropped here.
 */
function applicable(rules: readonly RuleSpec[], inGroup: boolean): ApplicableRule[] {
  return rules.flatMap((spec, index): ApplicableRule[] => {
    if (spec.target.startsWith('other_')) return [];
    if (spec.target === 'customer_group' && !inGroup) return [];
    return [
      {
        id: `rule-${index}`,
        target: spec.target as ApplicableRule['target'],
        subject: spec.subject === 'product' ? 'product' : 'category',
        subjectId: spec.subject === 'product' ? PRODUCT_ID : spec.subject,
        visibility: spec.visibility,
      },
    ];
  });
}

function decidedBy(decision: VisibilityDecision): DecidedBy {
  if (decision.rule === null) return decision.reason === 'disabled' ? 'disabled' : 'default';
  const subject = decision.rule.subject === 'product' ? 'product' : decision.rule.subjectId;
  return `${decision.rule.target}:${subject}` as DecidedBy;
}

function runProduct(c: ProductCase) {
  const decision = resolveProductVisibility({
    productId: PRODUCT_ID,
    enabled: c.enabled,
    categoryPath: categoryPathOf(c.category),
    rules: applicable(c.rules, c.inGroup),
  });
  return { visible: decision.visible, decidedBy: decidedBy(decision) };
}

function runCategory(c: CategoryCase) {
  const decision = resolveCategoryVisibility({
    categoryPath: categoryPathOf(c.category),
    rules: applicable(c.rules, true),
  });
  return { visible: decision.visible, decidedBy: decidedBy(decision) };
}

describe('resolveProductVisibility known answers', () => {
  it.each(FALLBACK_CASES.map((c) => [c.title, c] as const))('fallback: %s', (_, c) => {
    expect(runProduct(c)).toEqual(c.expected);
  });
  it.each(INHERITANCE_CASES.map((c) => [c.title, c] as const))('inheritance: %s', (_, c) => {
    expect(runProduct(c)).toEqual(c.expected);
  });
});

describe('resolveCategoryVisibility known answers', () => {
  it.each(CATEGORY_CASES.map((c) => [`${c.category}: ${c.title}`, c] as const))('%s', (_, c) => {
    expect(runCategory(c)).toEqual(c.expected);
  });
});

describe('resolveProductVisibility', () => {
  it('reports how far above the product the deciding category sits', () => {
    const decision = resolveProductVisibility({
      productId: PRODUCT_ID,
      enabled: true,
      categoryPath: ['ball', 'bearings', 'power'],
      rules: [
        {
          id: 'r1',
          target: 'website',
          subject: 'category',
          subjectId: 'power',
          visibility: 'hidden',
        },
      ],
    });
    expect(decision).toMatchObject({ visible: false, reason: 'rule', categoryDistance: 2 });
  });

  it('ignores a rule on another product', () => {
    const decision = resolveProductVisibility({
      productId: PRODUCT_ID,
      enabled: true,
      categoryPath: [],
      rules: [
        {
          id: 'r1',
          target: 'customer',
          subject: 'product',
          subjectId: 'another',
          visibility: 'hidden',
        },
      ],
    });
    expect(decision).toEqual({
      visible: true,
      reason: 'default',
      rule: null,
      categoryDistance: null,
    });
  });
});
