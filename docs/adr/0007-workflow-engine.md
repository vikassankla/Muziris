# 0007: Workflows are declared in code, with state and a transition log in PostgreSQL

- Status: proposed
- Date: 2026-10-27

## Context

Orders (week 4), RFQs and quotes move through steps such as submitted, approved and cancelled.
Each step change has rules (who may make it, whether the record is complete, whether a quote
has expired) and side effects (reserve stock, queue an email). B2B buyers and auditors need to
see who changed what and when. Two people may act on the same record at the same moment, and
the pilot runs on PostgreSQL alone (ADR 0002).

## Decision

A new `workflow` module owns a small engine and two tables, `workflow_instance` and
`workflow_transition_log`. Business modules (orders, RFQs, quotes) declare their workflows with
`defineWorkflow` and drive them through the engine; the workflow module knows nothing about
orders.

- **Definitions live in code**, not in the database: a name, steps, the initial step, and
  named transitions, each with the steps it may start `from`, the step it goes `to`, guards and
  actions. A zod schema validates the context the caller passes. Definitions are checked when
  they are declared, so a transition to a missing step or out of a final step fails at startup.
  Admins cannot edit workflows in the pilot.
- **Guards are pure functions** of the instance, the caller's context, the actor and `now`.
  They run in order and the first that fails refuses the transition. Data a guard needs is
  loaded by the caller into the context, so guards can be tested with known-answer tables
  without a database.
- **Actions run inside the transition's transaction** and receive it. If an action throws,
  the whole transition rolls back. Actions never call outside services directly; they queue
  that work so a rollback cannot leave an email sent for an order that did not change.
- **One instance per workflow and subject** (the record it governs, such as an order id).
  The instance holds the current step, the time it was entered and a version that counts
  transitions. Subject ids are not foreign keys, because the subject lives in another module.
- **Every transition is atomic**: lock the instance row (`select ... for update`), decide
  against the locked state, update the step, insert the log entry and run the actions, all in
  one transaction. Concurrent transitions on one instance queue on the lock, so each sees the
  step the previous one left and the log sequence has no gaps. A caller may pass the version
  it last saw; a different version refuses the transition (`stale_version`), which protects
  a user acting on an out-of-date screen.
- **Refusals are results, not errors**: `unknown_transition`, `stale_version`,
  `not_allowed_from_step` or `guard_failed`, with the guard's name. A refusal writes nothing.
  Missing instances, invalid input and broken stored data throw.
- **The log is append-only**: sequence 1 records the start; each later entry records the
  transition, from and to steps, the actor (admin user, buyer user or system), an optional
  note and the time from `now`. An instance with log entries cannot be deleted.
- Engine functions accept the database or an open transaction, so a module can create an
  order and start its workflow in one transaction.

## Consequences

- Workflows are reviewed and versioned like any other code, and tests cover every transition.
- Renaming or removing a step needs a data migration of stored instances. Until it runs,
  reading an instance in a missing step throws `UnknownStepError` rather than guessing.
- Changing a definition affects instances already running. If a later workflow needs old
  instances to keep old rules, add a definition version then; the pilot does not need it.
- Guards cannot query the database themselves. A caller that needs fresh data should read it
  inside the same transaction it passes to the engine and lock its own rows if they matter.
- Nothing in the database stops an `update` or `delete` of log rows; only the application's
  discipline does. A trigger or a separate role can enforce it later if audits require.
- Time-based transitions (quote expiry) need the job runner to call `performTransition` with
  the system actor; the engine does not schedule anything.
