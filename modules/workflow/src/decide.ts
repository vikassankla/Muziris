import type {
  Actor,
  TransitionDefinition,
  WorkflowDefinition,
  WorkflowInstance,
} from './definition.js';

/** Why a transition did not happen. Nothing is written when a transition is refused. */
export type TransitionRefusal =
  | { code: 'unknown_transition'; transition: string }
  | { code: 'stale_version'; expectedVersion: number; actualVersion: number }
  | { code: 'not_allowed_from_step'; transition: string; step: string }
  | { code: 'guard_failed'; transition: string; guard: string };

export interface TransitionRequest<TContext> {
  /** A transition name; may come from user input, so unknown names are refused, not thrown. */
  transition: string;
  context: TContext;
  actor: Actor;
  now: Date;
  /** The version the caller last saw. A different current version refuses the transition. */
  expectedVersion?: number | undefined;
}

export type TransitionDecision<TStep extends string, TContext> =
  | { ok: true; name: string; transition: TransitionDefinition<TStep, TContext> }
  | { ok: false; refusal: TransitionRefusal };

export class UnknownStepError extends Error {
  readonly workflowName: string;
  readonly step: string;

  constructor(workflowName: string, step: string) {
    super(`Workflow "${workflowName}" has no step "${step}"; stored instances need migrating`);
    this.name = 'UnknownStepError';
    this.workflowName = workflowName;
    this.step = step;
  }
}

/**
 * Pure decision: may this instance take this transition now? Checks, in order, that the
 * transition exists, that the caller saw the current version, that the instance is in one of
 * the transition's `from` steps, and then each guard.
 */
export function decideTransition<TStep extends string, TTransition extends string, TContext>(
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
  instance: WorkflowInstance<TStep>,
  request: TransitionRequest<TContext>,
): TransitionDecision<TStep, TContext> {
  if (!Object.hasOwn(definition.steps, instance.currentStep)) {
    throw new UnknownStepError(definition.name, instance.currentStep);
  }
  const name = request.transition;
  if (!Object.hasOwn(definition.transitions, name)) {
    return { ok: false, refusal: { code: 'unknown_transition', transition: name } };
  }
  const transition = definition.transitions[name as TTransition];

  if (request.expectedVersion !== undefined && request.expectedVersion !== instance.version) {
    return {
      ok: false,
      refusal: {
        code: 'stale_version',
        expectedVersion: request.expectedVersion,
        actualVersion: instance.version,
      },
    };
  }
  if (!transition.from.includes(instance.currentStep)) {
    return {
      ok: false,
      refusal: { code: 'not_allowed_from_step', transition: name, step: instance.currentStep },
    };
  }
  for (const guard of transition.guards ?? []) {
    const passed = guard.check({
      instance,
      context: request.context,
      actor: request.actor,
      now: request.now,
    });
    if (!passed) {
      return { ok: false, refusal: { code: 'guard_failed', transition: name, guard: guard.name } };
    }
  }
  return { ok: true, name, transition };
}
