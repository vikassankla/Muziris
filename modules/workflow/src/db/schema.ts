import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables owned by the workflow module. Other modules must not query these directly;
// they use the functions exported from @muziris/workflow.
//
// Workflow definitions live in code. The database holds only where each workflow instance is
// now and the log of every transition that got it there.

/** Who performed a transition. Ids point at identity users but are not foreign keys. */
export const actorType = pgEnum('workflow_actor_type', ['admin_user', 'buyer_user', 'system']);

/**
 * One run of a workflow for one subject, for example the order workflow for one order.
 * `version` counts transitions, starting at 1 when the workflow starts.
 */
export const instances = pgTable(
  'workflow_instance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowName: text('workflow_name').notNull(),
    /** The record this workflow governs, owned by another module (an order, an RFQ, a quote). */
    subjectId: uuid('subject_id').notNull(),
    currentStep: text('current_step').notNull(),
    version: integer('version').notNull().default(1),
    stepEnteredAt: timestamp('step_entered_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('workflow_instance_workflow_subject_uq').on(t.workflowName, t.subjectId),
    index('workflow_instance_workflow_step_idx').on(t.workflowName, t.currentStep),
    // Names follow the same pattern as in defineWorkflow.
    check(
      'workflow_instance_workflow_name_format',
      sql`${t.workflowName} ~ '^[a-z][a-z0-9_]{0,62}$'`,
    ),
    check(
      'workflow_instance_current_step_format',
      sql`${t.currentStep} ~ '^[a-z][a-z0-9_]{0,62}$'`,
    ),
    check('workflow_instance_version_positive', sql`${t.version} >= 1`),
  ],
);

/**
 * Every transition of every instance, in order. Sequence 1 is the start of the workflow (no
 * transition, no previous step). Rows are only ever inserted.
 */
export const transitionLog = pgTable(
  'workflow_transition_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'restrict' }),
    /** The instance version this transition produced. */
    sequence: integer('sequence').notNull(),
    transition: text('transition'),
    fromStep: text('from_step'),
    toStep: text('to_step').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('workflow_transition_log_instance_sequence_uq').on(t.instanceId, t.sequence),
    check('workflow_transition_log_sequence_positive', sql`${t.sequence} >= 1`),
    check(
      'workflow_transition_log_start_shape',
      sql`(${t.sequence} = 1) = (${t.transition} is null) and (${t.sequence} = 1) = (${t.fromStep} is null)`,
    ),
    check(
      'workflow_transition_log_actor_id_presence',
      sql`(${t.actorType} = 'system') = (${t.actorId} is null)`,
    ),
    check('workflow_transition_log_note_length', sql`char_length(${t.note}) <= 2000`),
  ],
);
