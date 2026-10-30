import { availableTransitions } from '@muziris/workflow';
import { describe, expect, it } from 'vitest';
import { ORDER_STEPS, orderWorkflow } from './workflow.js';

describe('the order workflow', () => {
  it.each([
    ['new', ['confirm', 'decline']],
    ['confirmed', ['start_processing']],
    ['processing', ['complete']],
    ['completed', []],
    ['declined', []],
  ] as const)('from %s allows %j', (step, transitions) => {
    expect(availableTransitions(orderWorkflow, step).sort()).toEqual([...transitions].sort());
  });

  it('has exactly the steps the spec names', () => {
    expect(Object.keys(orderWorkflow.steps).sort()).toEqual([...ORDER_STEPS].sort());
    expect(orderWorkflow.initialStep).toBe('new');
  });
});
