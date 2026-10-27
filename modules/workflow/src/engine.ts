import type { Database } from '@muziris/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { instances, transitionLog } from './db/schema.js';
import { decideTransition, UnknownStepError, type TransitionRefusal } from './decide.js';
import type {
  Actor,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowTransaction,
} from './definition.js';

/**
 * Engine functions accept the database or an open transaction, so the owning module can create
 * an order and start its workflow, or update it and transition it, in one transaction.
 */
export type Executor = Database | WorkflowTransaction;

export class WorkflowAlreadyStartedError extends Error {
  constructor(workflowName: string, subjectId: string) {
    super(`Workflow "${workflowName}" is already started for subject ${subjectId}`);
    this.name = 'WorkflowAlreadyStartedError';
  }
}

export class WorkflowNotStartedError extends Error {
  constructor(workflowName: string, subjectId: string) {
    super(`Workflow "${workflowName}" is not started for subject ${subjectId}`);
    this.name = 'WorkflowNotStartedError';
  }
}

export interface TransitionLogEntry {
  sequence: number;
  /** Null for the start of the workflow. */
  transition: string | null;
  fromStep: string | null;
  toStep: string;
  actor: Actor;
  note: string | null;
  occurredAt: Date;
}

export type TransitionResult<TStep extends string> =
  | { ok: true; instance: WorkflowInstance<TStep>; entry: TransitionLogEntry }
  | { ok: false; refusal: TransitionRefusal };

const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['admin_user', 'buyer_user']), id: z.uuid() }),
  z.object({ type: z.literal('system') }),
]);

const noteSchema = z.string().trim().min(1).max(2000).optional();

const startInputSchema = z.object({
  subjectId: z.uuid(),
  actor: actorSchema,
  now: z.date(),
  note: noteSchema,
});

export type StartWorkflowInput = z.input<typeof startInputSchema>;

const transitionInputSchema = z.object({
  subjectId: z.uuid(),
  transition: z.string().max(63),
  context: z.unknown(),
  actor: actorSchema,
  now: z.date(),
  note: noteSchema,
  expectedVersion: z.int().min(1).optional(),
});

export type PerformTransitionInput = z.input<typeof transitionInputSchema>;

function toInstance<TStep extends string>(
  definition: Pick<WorkflowDefinition<TStep>, 'name' | 'steps'>,
  row: typeof instances.$inferSelect,
): WorkflowInstance<TStep> {
  // A stored step the definition no longer has means a step was renamed or removed without
  // migrating instances. Fail loudly rather than guess.
  if (!isStepOf(definition, row.currentStep)) {
    throw new UnknownStepError(definition.name, row.currentStep);
  }
  return {
    id: row.id,
    workflowName: row.workflowName,
    subjectId: row.subjectId,
    currentStep: row.currentStep,
    version: row.version,
    stepEnteredAt: row.stepEnteredAt,
  };
}

function isStepOf<TStep extends string>(
  definition: Pick<WorkflowDefinition<TStep>, 'steps'>,
  step: string,
): step is TStep {
  return Object.hasOwn(definition.steps, step);
}

function toEntry(row: typeof transitionLog.$inferSelect): TransitionLogEntry {
  const actor: Actor =
    row.actorType === 'system' || row.actorId === null
      ? { type: 'system' }
      : { type: row.actorType, id: row.actorId };
  return {
    sequence: row.sequence,
    transition: row.transition,
    fromStep: row.fromStep,
    toStep: row.toStep,
    actor,
    note: row.note,
    occurredAt: row.occurredAt,
  };
}

function actorColumns(actor: Actor) {
  return actor.type === 'system'
    ? { actorType: actor.type, actorId: null }
    : { actorType: actor.type, actorId: actor.id };
}

function isUniqueViolation(error: unknown): boolean {
  // postgres.js puts the SQLSTATE on `code`; drizzle may wrap it in `cause`.
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (e) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505',
  );
}

/** Starts a workflow for a subject at the initial step and logs the start as sequence 1. */
export async function startWorkflow<TStep extends string, TTransition extends string, TContext>(
  db: Executor,
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
  input: StartWorkflowInput,
): Promise<WorkflowInstance<TStep>> {
  const values = startInputSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(instances)
        .values({
          workflowName: definition.name,
          subjectId: values.subjectId,
          currentStep: definition.initialStep,
          stepEnteredAt: values.now,
        })
        .returning();
      if (!row) throw new Error('Workflow instance insert returned no row');
      await tx.insert(transitionLog).values({
        instanceId: row.id,
        sequence: row.version,
        transition: null,
        fromStep: null,
        toStep: row.currentStep,
        ...actorColumns(values.actor),
        note: values.note ?? null,
        occurredAt: values.now,
      });
      return toInstance(definition, row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkflowAlreadyStartedError(definition.name, values.subjectId);
    }
    throw error;
  }
}

/**
 * Takes a transition in one transaction: locks the instance row, checks the transition and its
 * guards against the locked state, moves to the new step, logs it and runs the actions.
 * Concurrent transitions on one instance queue on the lock, so each sees the step the previous
 * one left. A refusal writes nothing; an action that throws rolls everything back.
 */
export async function performTransition<TStep extends string, TTransition extends string, TContext>(
  db: Executor,
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
  input: PerformTransitionInput,
): Promise<TransitionResult<TStep>> {
  const values = transitionInputSchema.parse(input);
  const context = definition.context.parse(values.context);

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(instances)
      .where(
        and(eq(instances.workflowName, definition.name), eq(instances.subjectId, values.subjectId)),
      )
      .for('update');
    if (!locked) throw new WorkflowNotStartedError(definition.name, values.subjectId);
    const before = toInstance(definition, locked);

    const decision = decideTransition(definition, before, {
      transition: values.transition,
      context,
      actor: values.actor,
      now: values.now,
      expectedVersion: values.expectedVersion,
    });
    if (!decision.ok) return decision;

    const [updated] = await tx
      .update(instances)
      .set({
        currentStep: decision.transition.to,
        version: sql`${instances.version} + 1`,
        stepEnteredAt: values.now,
        updatedAt: sql`now()`,
      })
      .where(eq(instances.id, before.id))
      .returning();
    if (!updated) throw new Error('Workflow instance update returned no row');
    const after = toInstance(definition, updated);

    const [logged] = await tx
      .insert(transitionLog)
      .values({
        instanceId: after.id,
        sequence: after.version,
        transition: decision.name,
        fromStep: before.currentStep,
        toStep: after.currentStep,
        ...actorColumns(values.actor),
        note: values.note ?? null,
        occurredAt: values.now,
      })
      .returning();
    if (!logged) throw new Error('Transition log insert returned no row');

    for (const action of decision.transition.actions ?? []) {
      await action.run({
        tx,
        instance: after,
        transition: decision.name,
        fromStep: before.currentStep,
        context,
        actor: values.actor,
        now: values.now,
      });
    }
    return { ok: true, instance: after, entry: toEntry(logged) };
  });
}

export async function getWorkflowInstance<
  TStep extends string,
  TTransition extends string,
  TContext,
>(
  db: Executor,
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
  subjectId: string,
): Promise<WorkflowInstance<TStep> | undefined> {
  const [row] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.workflowName, definition.name), eq(instances.subjectId, subjectId)))
    .limit(1);
  return row ? toInstance(definition, row) : undefined;
}

/** The full history of one instance, oldest first. Empty if the workflow was never started. */
export async function listTransitionLog<TStep extends string, TTransition extends string, TContext>(
  db: Executor,
  definition: WorkflowDefinition<TStep, TTransition, TContext>,
  subjectId: string,
): Promise<TransitionLogEntry[]> {
  const rows = await db
    .select({ entry: transitionLog })
    .from(transitionLog)
    .innerJoin(instances, eq(instances.id, transitionLog.instanceId))
    .where(and(eq(instances.workflowName, definition.name), eq(instances.subjectId, subjectId)))
    .orderBy(asc(transitionLog.sequence));
  return rows.map((r) => toEntry(r.entry));
}
