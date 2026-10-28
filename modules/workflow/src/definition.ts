import type { Database } from '@muziris/db';
import type { z } from 'zod';

/** The transaction a transition runs in. Actions write through it so they commit or roll back with it. */
export type WorkflowTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Who performs a transition: an admin user, a buyer user, or the system (a job, a webhook). */
export type Actor = { type: 'admin_user' | 'buyer_user'; id: string } | { type: 'system' };

/** Where one workflow instance stands. */
export interface WorkflowInstance<TStep extends string = string> {
  id: string;
  workflowName: string;
  subjectId: string;
  currentStep: TStep;
  /** Counts transitions: 1 after the start, plus one per transition. */
  version: number;
  stepEnteredAt: Date;
}

export interface StepDefinition {
  readonly description: string;
  /** A final step has no outgoing transitions; the workflow is over. */
  readonly final?: boolean;
}

export interface GuardArgs<TStep extends string, TContext> {
  instance: WorkflowInstance<TStep>;
  context: TContext;
  actor: Actor;
  now: Date;
}

/**
 * A condition that must hold for a transition to happen. Guards are pure: they see only the
 * instance, the caller's context, the actor and the clock. Data a guard needs is loaded by the
 * caller into the context.
 */
export interface Guard<TStep extends string, TContext> {
  readonly name: string;
  readonly check: (args: GuardArgs<TStep, TContext>) => boolean;
}

export interface ActionArgs<TStep extends string, TContext> {
  tx: WorkflowTransaction;
  /** The instance after the transition. */
  instance: WorkflowInstance<TStep>;
  transition: string;
  fromStep: TStep;
  context: TContext;
  actor: Actor;
  now: Date;
}

/**
 * Work done as part of a transition, inside its transaction. If an action throws, the whole
 * transition rolls back. Actions must not call outside services; queue that work instead.
 */
export interface Action<TStep extends string, TContext> {
  readonly name: string;
  readonly run: (args: ActionArgs<TStep, TContext>) => Promise<void>;
}

export interface TransitionDefinition<TStep extends string, TContext> {
  readonly description: string;
  readonly from: readonly TStep[];
  readonly to: TStep;
  /** Checked in order; the first that fails refuses the transition. */
  readonly guards?: readonly Guard<TStep, TContext>[];
  /** Run in order after the step changes. */
  readonly actions?: readonly Action<TStep, TContext>[];
}

export interface WorkflowDefinition<
  TStep extends string = string,
  TTransition extends string = string,
  TContext = unknown,
> {
  /** Stored on every instance, for example "order", "rfq" or "quote". */
  readonly name: string;
  readonly description: string;
  /** Validates the context a caller passes to a transition. */
  readonly context: z.ZodType<TContext>;
  readonly initialStep: NoInfer<TStep>;
  readonly steps: Readonly<Record<TStep, StepDefinition>>;
  readonly transitions: Readonly<
    Record<TTransition, TransitionDefinition<NoInfer<TStep>, NoInfer<TContext>>>
  >;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

function checkName(kind: string, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new TypeError(
      `Workflow ${kind} "${name}" must be 1 to 63 lowercase letters, digits or _`,
    );
  }
}

/**
 * Declares a workflow in code. Checks the definition is consistent, so a mistake fails at
 * startup instead of in the middle of an order.
 */
export function defineWorkflow<TStep extends string, TTransition extends string, TContext>(
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
): WorkflowDefinition<TStep, TTransition, TContext> {
  checkName('name', definition.name);
  const steps = Object.keys(definition.steps);
  if (steps.length === 0) throw new TypeError(`Workflow "${definition.name}" has no steps`);
  for (const step of steps) checkName('step', step);

  const isStep = (step: string) => Object.hasOwn(definition.steps, step);
  const isFinal = (step: TStep) => definition.steps[step].final === true;
  if (!isStep(definition.initialStep)) {
    throw new TypeError(`Initial step "${definition.initialStep}" is not a step`);
  }
  if (isFinal(definition.initialStep)) {
    throw new TypeError(`Initial step "${definition.initialStep}" cannot be final`);
  }

  for (const [name, transition] of Object.entries<TransitionDefinition<TStep, TContext>>(
    definition.transitions,
  )) {
    checkName('transition', name);
    if (transition.from.length === 0) {
      throw new TypeError(`Transition "${name}" must start from at least one step`);
    }
    for (const step of [...transition.from, transition.to]) {
      if (!isStep(step)) throw new TypeError(`Transition "${name}" uses unknown step "${step}"`);
    }
    for (const step of transition.from) {
      if (isFinal(step)) {
        throw new TypeError(`Transition "${name}" leaves final step "${step}"`);
      }
    }
  }
  return Object.freeze({ ...definition });
}

/** The transitions whose `from` includes the step, in definition order. Guards are not checked. */
export function availableTransitions<TStep extends string, TTransition extends string, TContext>(
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
  step: TStep,
): TTransition[] {
  return (Object.keys(definition.transitions) as TTransition[]).filter((name) =>
    definition.transitions[name].from.includes(step),
  );
}
