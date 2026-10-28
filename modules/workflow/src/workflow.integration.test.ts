import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineWorkflow,
  getWorkflowInstance,
  listTransitionLog,
  performTransition,
  startWorkflow,
  UnknownStepError,
  WorkflowAlreadyStartedError,
  WorkflowNotStartedError,
  type Actor,
  type TransitionRefusal,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];

const SUBJECT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_SUBJECT = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const agent: Actor = { type: 'admin_user', id: AGENT_ID };
const buyer: Actor = { type: 'buyer_user', id: '00000000-0000-4000-8000-000000000002' };
const system: Actor = { type: 'system' };

const t0 = new Date('2026-11-02T09:00:00.000Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

// A support-ticket workflow used only by these tests. Its actions write to a table the test
// creates, to show that actions commit and roll back with the transition.
const ticket = defineWorkflow({
  name: 'test_ticket',
  description: 'A ticket that is worked on and then resolved or closed',
  context: z.object({
    resolution: z.string().default(''),
    failAction: z.boolean().default(false),
    slowAction: z.boolean().default(false),
  }),
  initialStep: 'open',
  steps: {
    open: { description: 'Waiting for work' },
    in_progress: { description: 'Being worked on' },
    resolved: { description: 'Fixed', final: true },
    closed: { description: 'Closed without a fix', final: true },
  },
  transitions: {
    start_work: {
      description: 'An admin user picks it up',
      from: ['open'],
      to: 'in_progress',
      guards: [{ name: 'admin_only', check: ({ actor }) => actor.type === 'admin_user' }],
    },
    comment: {
      description: 'Record a comment without changing the step',
      from: ['open', 'in_progress'],
      to: 'in_progress',
    },
    touch: {
      description: 'Record activity on an open ticket',
      from: ['open'],
      to: 'open',
    },
    resolve: {
      description: 'Mark it fixed',
      from: ['in_progress'],
      to: 'resolved',
      guards: [{ name: 'has_resolution', check: ({ context }) => context.resolution.length > 0 }],
      actions: [
        {
          name: 'record_effect',
          run: async ({ tx, instance, transition, fromStep, now }) => {
            await tx.execute(
              sql`insert into test_workflow_effect (subject_id, transition, from_step, at)
                  values (${instance.subjectId}, ${transition}, ${fromStep}, ${now.toISOString()}::timestamptz)`,
            );
          },
        },
        {
          name: 'fail_on_request',
          run: ({ context }) =>
            context.failAction ? Promise.reject(new Error('action failed')) : Promise.resolve(),
        },
      ],
    },
    close: {
      description: 'Close without a fix',
      from: ['open', 'in_progress'],
      to: 'closed',
      actions: [
        {
          name: 'hold_the_lock',
          run: async ({ tx, context }) => {
            if (context.slowAction) await tx.execute(sql`select pg_sleep(0.2)`);
          },
        },
      ],
    },
  },
});

type TicketTransition = keyof typeof ticket.transitions;

describe.skipIf(!url)('workflow module against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'workflow');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
    await handle.db.execute(sql`create table if not exists test_workflow_effect (
      subject_id uuid not null, transition text not null, from_step text not null,
      at timestamptz not null)`);
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate workflow_transition_log, workflow_instance, test_workflow_effect cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  const start = (subjectId = SUBJECT) =>
    startWorkflow(handle.db, ticket, { subjectId, actor: buyer, now: t0, note: 'Printer jam' });

  const transition = (
    name: string,
    options: {
      actor?: Actor;
      context?: Record<string, unknown>;
      now?: Date;
      expectedVersion?: number;
      note?: string;
    } = {},
  ) =>
    performTransition(handle.db, ticket, {
      subjectId: SUBJECT,
      transition: name,
      context: options.context ?? {},
      actor: options.actor ?? agent,
      now: options.now ?? at(5),
      expectedVersion: options.expectedVersion,
      note: options.note,
    });

  async function effects() {
    return handle.db.execute(sql`select transition, from_step from test_workflow_effect`);
  }

  describe('starting', () => {
    it('puts the instance at the initial step and logs the start as sequence 1', async () => {
      const instance = await start();
      expect(instance).toEqual({
        id: expect.any(String) as unknown,
        workflowName: 'test_ticket',
        subjectId: SUBJECT,
        currentStep: 'open',
        version: 1,
        stepEnteredAt: t0,
      });
      expect(await listTransitionLog(handle.db, ticket, SUBJECT)).toEqual([
        {
          sequence: 1,
          transition: null,
          fromStep: null,
          toStep: 'open',
          actor: buyer,
          note: 'Printer jam',
          occurredAt: t0,
        },
      ]);
    });

    it('starts once per subject and workflow', async () => {
      await start();
      await expect(start()).rejects.toBeInstanceOf(WorkflowAlreadyStartedError);
      await expect(start(OTHER_SUBJECT)).resolves.toMatchObject({ currentStep: 'open' });
    });

    it('refuses to transition an instance that was never started', async () => {
      await expect(transition('start_work')).rejects.toBeInstanceOf(WorkflowNotStartedError);
      expect(await getWorkflowInstance(handle.db, ticket, SUBJECT)).toBeUndefined();
      expect(await listTransitionLog(handle.db, ticket, SUBJECT)).toEqual([]);
    });
  });

  describe('transitions', () => {
    // Known answers: transitions taken first, then the one attempted, and what must result.
    // Refused transitions leave the step, version and log exactly as they were.
    it.each<
      [
        string,
        TicketTransition[],
        string,
        Actor,
        Record<string, unknown>,
        string,
        TransitionRefusal | null,
      ]
    >([
      ['admin user starts work', [], 'start_work', agent, {}, 'in_progress', null],
      [
        'buyer user cannot start work',
        [],
        'start_work',
        buyer,
        {},
        'open',
        { code: 'guard_failed', transition: 'start_work', guard: 'admin_only' },
      ],
      ['comment moves an open ticket into progress', [], 'comment', buyer, {}, 'in_progress', null],
      [
        'comment keeps a ticket in progress',
        ['start_work'],
        'comment',
        buyer,
        {},
        'in_progress',
        null,
      ],
      [
        'resolve with a resolution',
        ['start_work'],
        'resolve',
        agent,
        { resolution: 'Cleared paper' },
        'resolved',
        null,
      ],
      [
        'resolve without a resolution',
        ['start_work'],
        'resolve',
        agent,
        {},
        'in_progress',
        { code: 'guard_failed', transition: 'resolve', guard: 'has_resolution' },
      ],
      [
        'resolve straight from open',
        [],
        'resolve',
        agent,
        { resolution: 'x' },
        'open',
        { code: 'not_allowed_from_step', transition: 'resolve', step: 'open' },
      ],
      ['system closes an open ticket', [], 'close', system, {}, 'closed', null],
      [
        'nothing leaves a final step',
        ['close'],
        'comment',
        agent,
        {},
        'closed',
        { code: 'not_allowed_from_step', transition: 'comment', step: 'closed' },
      ],
      [
        'unknown transition',
        [],
        'escalate',
        agent,
        {},
        'open',
        { code: 'unknown_transition', transition: 'escalate' },
      ],
    ])('%s', async (_label, before, name, actor, context, expectedStep, refusal) => {
      await start();
      for (const previous of before) {
        const result = await transition(previous);
        expect(result.ok).toBe(true);
      }
      const logBefore = await listTransitionLog(handle.db, ticket, SUBJECT);

      const result = await transition(name, { actor, context, now: at(30), note: 'Attempt' });

      const instance = await getWorkflowInstance(handle.db, ticket, SUBJECT);
      const log = await listTransitionLog(handle.db, ticket, SUBJECT);
      expect(instance?.currentStep).toBe(expectedStep);
      if (refusal) {
        expect(result).toEqual({ ok: false, refusal });
        expect(instance?.version).toBe(1 + before.length);
        expect(log).toEqual(logBefore);
      } else {
        const entry = {
          sequence: 2 + before.length,
          transition: name,
          fromStep: logBefore.at(-1)?.toStep,
          toStep: expectedStep,
          actor,
          note: 'Attempt',
          occurredAt: at(30),
        };
        expect(result).toEqual({ ok: true, instance, entry });
        expect(instance).toMatchObject({ version: 2 + before.length, stepEnteredAt: at(30) });
        expect(log).toEqual([...logBefore, entry]);
      }
    });

    it('refuses a transition when the caller saw an older version', async () => {
      await start();
      await transition('comment');
      expect(await transition('close', { expectedVersion: 1 })).toEqual({
        ok: false,
        refusal: { code: 'stale_version', expectedVersion: 1, actualVersion: 2 },
      });
      expect(await transition('close', { expectedVersion: 2 })).toMatchObject({ ok: true });
    });

    it('validates the context before touching the database', async () => {
      await start();
      await expect(transition('close', { context: { slowAction: 'yes' } })).rejects.toThrow();
      expect(await listTransitionLog(handle.db, ticket, SUBJECT)).toHaveLength(1);
    });

    it('keeps instances of different subjects apart', async () => {
      await start();
      await start(OTHER_SUBJECT);
      await transition('close');
      expect(await getWorkflowInstance(handle.db, ticket, OTHER_SUBJECT)).toMatchObject({
        currentStep: 'open',
        version: 1,
      });
    });
  });

  describe('atomicity', () => {
    it('runs actions in the transition transaction', async () => {
      await start();
      await transition('start_work');
      await transition('resolve', { context: { resolution: 'Cleared paper' } });
      expect(await effects()).toEqual([{ transition: 'resolve', from_step: 'in_progress' }]);
    });

    it('rolls back the step, the log and earlier actions when an action throws', async () => {
      await start();
      await transition('start_work');
      await expect(
        transition('resolve', { context: { resolution: 'x', failAction: true } }),
      ).rejects.toThrow('action failed');
      expect(await getWorkflowInstance(handle.db, ticket, SUBJECT)).toMatchObject({
        currentStep: 'in_progress',
        version: 2,
      });
      expect(await listTransitionLog(handle.db, ticket, SUBJECT)).toHaveLength(2);
      expect(await effects()).toEqual([]);
    });

    it('joins a transaction the caller already holds', async () => {
      await expect(
        handle.db.transaction(async (tx) => {
          await startWorkflow(tx, ticket, { subjectId: SUBJECT, actor: buyer, now: t0 });
          await performTransition(tx, ticket, {
            subjectId: SUBJECT,
            transition: 'close',
            context: {},
            actor: agent,
            now: at(1),
          });
          throw new Error('the caller changed its mind');
        }),
      ).rejects.toThrow('the caller changed its mind');
      expect(await getWorkflowInstance(handle.db, ticket, SUBJECT)).toBeUndefined();
      expect(await listTransitionLog(handle.db, ticket, SUBJECT)).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('lets only one of two racing transitions leave a step', async () => {
      await start();
      const results = await Promise.all([
        transition('close', { context: { slowAction: true } }),
        transition('close'),
      ]);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ refusal: { code: 'not_allowed_from_step' } });
      expect(await listTransitionLog(handle.db, ticket, SUBJECT)).toHaveLength(2);
    });

    it('serialises many concurrent transitions into one gapless sequence', async () => {
      await start();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => transition('touch', { now: at(i + 1) })),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const log = await listTransitionLog(handle.db, ticket, SUBJECT);
      expect(log.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(await getWorkflowInstance(handle.db, ticket, SUBJECT)).toMatchObject({ version: 9 });
    });
  });

  describe('stored data', () => {
    it('fails loudly when a stored step is no longer in the definition', async () => {
      await start();
      await handle.db.execute(sql`update workflow_instance set current_step = 'on_hold'`);
      await expect(getWorkflowInstance(handle.db, ticket, SUBJECT)).rejects.toBeInstanceOf(
        UnknownStepError,
      );
      await expect(transition('close')).rejects.toBeInstanceOf(UnknownStepError);
    });

    it.each<[string, Actor['type'], string | null, number, string | null, string | null]>([
      ['a system actor with an id', 'system', AGENT_ID, 2, 'close', 'open'],
      ['a user actor without an id', 'admin_user', null, 2, 'close', 'open'],
      ['a later entry without a transition', 'system', null, 2, null, 'open'],
      ['a start entry with a transition', 'system', null, 1, 'close', null],
    ])('rejects a log row with %s', async (_label, actorType, actorId, sequence, name, from) => {
      const instance = await start();
      await expect(
        handle.db.execute(
          sql`insert into workflow_transition_log
            (instance_id, actor_type, actor_id, sequence, transition, from_step, to_step, occurred_at)
            values (${instance.id}, ${actorType}, ${actorId}, ${sequence}, ${name}, ${from},
              'closed', now())`,
        ),
      ).rejects.toThrow();
    });

    it('keeps instances that have a log from being deleted', async () => {
      await start();
      await expect(handle.db.execute(sql`delete from workflow_instance`)).rejects.toThrow();
    });
  });
});
