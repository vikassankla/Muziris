import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineWorkflow, type WorkflowDefinition } from './definition.js';

const valid: WorkflowDefinition = {
  name: 'test_definition',
  description: 'A workflow for definition checks',
  context: z.object({}),
  initialStep: 'open',
  steps: {
    open: { description: 'Open' },
    closed: { description: 'Closed', final: true },
  },
  transitions: {
    close: { description: 'Close it', from: ['open'], to: 'closed' },
  },
};

describe('defineWorkflow', () => {
  it('accepts a consistent definition and returns it frozen', () => {
    const definition = defineWorkflow(valid);
    expect(definition.name).toBe('test_definition');
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it('allows a transition back to the step it starts from', () => {
    expect(() =>
      defineWorkflow({
        ...valid,
        transitions: { touch: { description: 'Record a change', from: ['open'], to: 'open' } },
      }),
    ).not.toThrow();
  });

  // Known answers: each kind of inconsistency and the message that names it.
  it.each<[string, Partial<WorkflowDefinition>, RegExp]>([
    ['a badly formed name', { name: 'Order Flow' }, /Workflow name "Order Flow"/],
    ['no steps', { steps: {}, transitions: {} }, /has no steps/],
    [
      'a badly formed step name',
      { steps: { ...valid.steps, 'On-Hold': { description: 'x' } } },
      /Workflow step "On-Hold"/,
    ],
    ['an unknown initial step', { initialStep: 'draft' }, /Initial step "draft" is not a step/],
    ['a final initial step', { initialStep: 'closed' }, /Initial step "closed" cannot be final/],
    [
      'a badly formed transition name',
      { transitions: { Close: { description: 'x', from: ['open'], to: 'closed' } } },
      /Workflow transition "Close"/,
    ],
    [
      'a transition from no steps',
      { transitions: { close: { description: 'x', from: [], to: 'closed' } } },
      /"close" must start from at least one step/,
    ],
    [
      'a transition from an unknown step',
      { transitions: { close: { description: 'x', from: ['pending'], to: 'closed' } } },
      /"close" uses unknown step "pending"/,
    ],
    [
      'a transition to an unknown step',
      { transitions: { close: { description: 'x', from: ['open'], to: 'archived' } } },
      /"close" uses unknown step "archived"/,
    ],
    [
      'a transition out of a final step',
      { transitions: { reopen: { description: 'x', from: ['closed'], to: 'open' } } },
      /"reopen" leaves final step "closed"/,
    ],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => defineWorkflow({ ...valid, ...overrides })).toThrow(message);
  });
});
