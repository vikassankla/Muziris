import { defineWorkflow, type Action } from '@muziris/workflow';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { orders } from './db/schema.js';

export const ORDER_STEPS = ['new', 'confirmed', 'processing', 'completed', 'declined'] as const;

export type OrderStep = (typeof ORDER_STEPS)[number];

export const ORDER_TRANSITIONS = ['confirm', 'decline', 'start_processing', 'complete'] as const;

export type OrderTransition = (typeof ORDER_TRANSITIONS)[number];

/** Transitions carry no form data in the pilot. */
const orderContext = z.object({}).strict();

type OrderContext = z.output<typeof orderContext>;

/** Keeps the order's own step equal to its workflow instance, inside the transition. */
const recordStep: Action<OrderStep, OrderContext> = {
  name: 'record_step',
  run: async ({ tx, instance }) => {
    await tx
      .update(orders)
      .set({ step: instance.currentStep })
      .where(eq(orders.id, instance.subjectId));
  },
};

/** The order processing workflow (FR-WF-4, ADR 0016). Admins with order.manage run it. */
export const orderWorkflow = defineWorkflow<OrderStep, OrderTransition, OrderContext>({
  name: 'order_processing',
  description: 'An order from placing to completion',
  context: orderContext,
  initialStep: 'new',
  steps: {
    new: { description: 'Placed by the buyer, waiting for the seller' },
    confirmed: { description: 'Accepted by the seller' },
    processing: { description: 'Being picked, packed and shipped' },
    completed: { description: 'Delivered', final: true },
    declined: { description: 'Not accepted by the seller', final: true },
  },
  transitions: {
    confirm: {
      description: 'Accept the order',
      from: ['new'],
      to: 'confirmed',
      actions: [recordStep],
    },
    decline: {
      description: 'Decline the order',
      from: ['new'],
      to: 'declined',
      actions: [recordStep],
    },
    start_processing: {
      description: 'Start picking and shipping',
      from: ['confirmed'],
      to: 'processing',
      actions: [recordStep],
    },
    complete: {
      description: 'Mark the order delivered',
      from: ['processing'],
      to: 'completed',
      actions: [recordStep],
    },
  },
});
