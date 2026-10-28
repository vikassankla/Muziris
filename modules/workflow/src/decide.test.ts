import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decideTransition, UnknownStepError, type TransitionRefusal } from './decide.js';
import {
  availableTransitions,
  defineWorkflow,
  type Actor,
  type WorkflowInstance,
} from './definition.js';

const REQUESTER = '00000000-0000-4000-8000-000000000001';
const MANAGER = '00000000-0000-4000-8000-000000000002';

const buyer: Actor = { type: 'buyer_user', id: REQUESTER };
const manager: Actor = { type: 'admin_user', id: MANAGER };
const requesterAsAdmin: Actor = { type: 'admin_user', id: REQUESTER };
const system: Actor = { type: 'system' };

// A small approval workflow used only by these tests.
const review = defineWorkflow({
  name: 'test_review',
  description: 'A request that a manager approves or rejects',
  context: z.object({
    lineCount: z.int().min(0),
    requestedBy: z.uuid(),
    expiresAt: z.date(),
  }),
  initialStep: 'draft',
  steps: {
    draft: { description: 'Being prepared' },
    submitted: { description: 'Waiting for a manager' },
    approved: { description: 'Approved', final: true },
    rejected: { description: 'Sent back to the requester' },
    cancelled: { description: 'Withdrawn', final: true },
  },
  transitions: {
    submit: {
      description: 'Send for approval',
      from: ['draft'],
      to: 'submitted',
      guards: [
        { name: 'has_lines', check: ({ context }) => context.lineCount > 0 },
        { name: 'not_expired', check: ({ context, now }) => now < context.expiresAt },
      ],
    },
    approve: {
      description: 'Approve the request',
      from: ['submitted'],
      to: 'approved',
      guards: [
        { name: 'admin_only', check: ({ actor }) => actor.type === 'admin_user' },
        {
          name: 'not_own_request',
          check: ({ actor, context }) =>
            actor.type === 'system' || actor.id !== context.requestedBy,
        },
      ],
    },
    reject: {
      description: 'Send back to the requester',
      from: ['submitted'],
      to: 'rejected',
      guards: [{ name: 'admin_only', check: ({ actor }) => actor.type === 'admin_user' }],
    },
    resubmit: {
      description: 'Send again after changes',
      from: ['rejected'],
      to: 'submitted',
      guards: [{ name: 'has_lines', check: ({ context }) => context.lineCount > 0 }],
    },
    cancel: {
      description: 'Withdraw the request',
      from: ['draft', 'submitted', 'rejected'],
      to: 'cancelled',
    },
  },
});

type Step = keyof typeof review.steps;

const EXPIRES = new Date('2026-11-30T18:30:00.000Z');
const BEFORE = new Date('2026-11-30T18:29:59.999Z');

const context = { lineCount: 3, requestedBy: REQUESTER, expiresAt: EXPIRES };

function instanceAt(currentStep: Step, version = 4): WorkflowInstance<Step> {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    workflowName: review.name,
    subjectId: '00000000-0000-4000-8000-0000000000bb',
    currentStep,
    version,
    stepEnteredAt: new Date('2026-11-02T09:00:00.000Z'),
  };
}

describe('decideTransition', () => {
  // Known answers: every transition from every step, with the actor and clock that matter.
  // `null` means the transition is allowed.
  it.each<[Step, string, Actor, Partial<typeof context>, Date, TransitionRefusal | null]>([
    // Allowed transitions.
    ['draft', 'submit', buyer, {}, BEFORE, null],
    ['draft', 'cancel', buyer, {}, BEFORE, null],
    ['submitted', 'approve', manager, {}, BEFORE, null],
    ['submitted', 'reject', manager, {}, BEFORE, null],
    ['submitted', 'cancel', buyer, {}, BEFORE, null],
    ['rejected', 'resubmit', buyer, {}, BEFORE, null],
    ['rejected', 'cancel', buyer, {}, BEFORE, null],

    // Guard failures, including the expiry boundary: expiring at the same instant is expired.
    ['draft', 'submit', buyer, { lineCount: 0 }, BEFORE, guard('submit', 'has_lines')],
    ['draft', 'submit', buyer, {}, EXPIRES, guard('submit', 'not_expired')],
    // Guards run in order, so the first failure is reported.
    ['draft', 'submit', buyer, { lineCount: 0 }, EXPIRES, guard('submit', 'has_lines')],
    ['submitted', 'approve', buyer, {}, BEFORE, guard('approve', 'admin_only')],
    ['submitted', 'approve', system, {}, BEFORE, guard('approve', 'admin_only')],
    ['submitted', 'approve', requesterAsAdmin, {}, BEFORE, guard('approve', 'not_own_request')],
    ['submitted', 'reject', buyer, {}, BEFORE, guard('reject', 'admin_only')],
    ['rejected', 'resubmit', buyer, { lineCount: 0 }, BEFORE, guard('resubmit', 'has_lines')],

    // Refused from the wrong step, including both final steps.
    ['draft', 'approve', manager, {}, BEFORE, wrongStep('approve', 'draft')],
    ['draft', 'resubmit', buyer, {}, BEFORE, wrongStep('resubmit', 'draft')],
    ['submitted', 'submit', buyer, {}, BEFORE, wrongStep('submit', 'submitted')],
    ['rejected', 'approve', manager, {}, BEFORE, wrongStep('approve', 'rejected')],
    ['approved', 'cancel', buyer, {}, BEFORE, wrongStep('cancel', 'approved')],
    ['approved', 'reject', manager, {}, BEFORE, wrongStep('reject', 'approved')],
    ['cancelled', 'submit', buyer, {}, BEFORE, wrongStep('submit', 'cancelled')],

    // Unknown names are refused, including inherited object properties.
    ['draft', 'publish', buyer, {}, BEFORE, { code: 'unknown_transition', transition: 'publish' }],
    [
      'draft',
      'toString',
      buyer,
      {},
      BEFORE,
      { code: 'unknown_transition', transition: 'toString' },
    ],
  ])('%s --%s--> as %j with %j at %s', (step, transition, actor, overrides, now, refusal) => {
    const decision = decideTransition(review, instanceAt(step), {
      transition,
      context: { ...context, ...overrides },
      actor,
      now,
    });
    if (refusal === null) {
      expect(decision).toMatchObject({ ok: true, name: transition });
    } else {
      expect(decision).toEqual({ ok: false, refusal });
    }
  });

  it('refuses a stale version before looking at the step or guards', () => {
    const decision = decideTransition(review, instanceAt('draft', 4), {
      transition: 'submit',
      context: { ...context, lineCount: 0 },
      actor: buyer,
      now: BEFORE,
      expectedVersion: 3,
    });
    expect(decision).toEqual({
      ok: false,
      refusal: { code: 'stale_version', expectedVersion: 3, actualVersion: 4 },
    });
  });

  it('allows the transition when the expected version is current', () => {
    const decision = decideTransition(review, instanceAt('draft', 4), {
      transition: 'submit',
      context,
      actor: buyer,
      now: BEFORE,
      expectedVersion: 4,
    });
    expect(decision.ok).toBe(true);
  });

  it('fails loudly on a stored step the definition does not have', () => {
    const orphan = { ...instanceAt('draft'), currentStep: 'on_hold' as Step };
    expect(() =>
      decideTransition(review, orphan, {
        transition: 'cancel',
        context,
        actor: buyer,
        now: BEFORE,
      }),
    ).toThrow(UnknownStepError);
  });
});

describe('availableTransitions', () => {
  it.each<[Step, string[]]>([
    ['draft', ['submit', 'cancel']],
    ['submitted', ['approve', 'reject', 'cancel']],
    ['rejected', ['resubmit', 'cancel']],
    ['approved', []],
    ['cancelled', []],
  ])('from %s lists %j', (step, expected) => {
    expect(availableTransitions(review, step)).toEqual(expected);
  });
});

function guard(transition: string, name: string): TransitionRefusal {
  return { code: 'guard_failed', transition, guard: name };
}

function wrongStep(transition: string, step: string): TransitionRefusal {
  return { code: 'not_allowed_from_step', transition, step };
}
