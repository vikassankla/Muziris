# 0025: A job runner on PostgreSQL with pg-boss

- Status: accepted
- Date: 2026-11-03

## Context

Several decisions wait for a job runner, and until it exists an admin or a script does the
work by hand:

- **Pricing, visibility and search builds** (ADR 0011, 0012, 0013) run only when an admin
  presses "Build now" or a CLI command runs them. Until a build runs, buyers see old prices or
  miss new products.
- **Expired sessions and old rate-limit counters** (ADR 0005) pile up: `deleteDeadSessions` and
  `pruneRateLimits` are never scheduled.
- **Emails** (ADR 0020) are sent by a 10-second timer inside the API process, so every API
  process sends.
- **Time-based workflow transitions**, such as quote expiry (ADR 0007), cannot happen at all.

PostgreSQL is the only infrastructure (ADR 0002), so the runner must not need Redis or a
broker.

## Decision

Use **pg-boss** (pinned to one version) as the job queue, storing its jobs in PostgreSQL in its
own schema, `pgboss`.

### Running jobs

- **Two ways to run.**
  - By default the API process also runs the workers, so a small install stays one process.
  - `JOB_WORKERS=false` turns them off in the API. `pnpm --filter @muziris/api worker` then
    runs the workers alone, so web and jobs can scale apart.
- **Schema.** `pnpm db:migrate` installs and upgrades pg-boss's schema, so the running API's
  database user needs no rights to change the schema.
- **Enqueue inside the write.** A change enqueues its job in the same transaction as the change
  itself, through pg-boss's `db` option and our transaction. A rolled-back change enqueues
  nothing, and a committed one is never missed.
- **Modules stay apart.** A module exports its job handlers and job names. `apps/api` registers
  them. A module never imports pg-boss: it gets a `JobQueue` interface with
  `enqueue(name, data, options)`.

### The jobs

| Job                  | When                                                   | How                                                             |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| `pricing.build`      | After price list, price and assignment writes          | Singleton key, 15-second debounce: a burst of edits builds once |
| `visibility.build`   | After rule writes and catalog changes                  | Same                                                            |
| `search.build`       | After catalog changes made outside the catalog routes  | Same; the routes keep reindexing one product at a time          |
| `notifications.send` | After an order or invitation commits, and every minute | Replaces the API's 10-second timer                              |
| `sessions.cleanup`   | Hourly                                                 | `deleteDeadSessions`, then `pruneRateLimits`                    |
| `workflow.timers`    | Every 5 minutes                                        | Performs due time-based transitions as the system actor         |

The admin "Build now" actions enqueue the same job and answer 202. The banners show "Queued",
"Building" or the last build's time, read from pg-boss and the builds' state tables. The CLI
build commands stay as they are, for scripts.

### Failures

- **Retries.** A job retries 3 times with exponential backoff, then moves to a failed state.
- **Logging.** Failures are logged with the job name and id, never the job data, because data
  can hold an email address.
- **Visibility.** A read-only **System > Jobs** screen, under a new permission `job.view`,
  lists failed and queued jobs. Until it exists, the logs and `pgboss.job` are the place to
  look.
- **Idempotence.** Every handler is idempotent. Builds already are full rebuilds, and the email
  sender already claims each message once.

## Consequences

- One new dependency (pg-boss). It needs a review of its licence (MIT) and its SQL. No new
  infrastructure.
- Buyers see price, visibility and catalog changes within seconds, without an admin. The
  build banners in ADR 0022 and the products list become status, not a call to action.
- The ADRs above lose their "until the job runner lands" notes. The install guide no longer
  asks for manual builds.
- Two processes become possible, so logs and health checks need a process name. The worker
  gets `/health/live` on its own port.
- Not in this decision: jobs scheduled by admins (reports, exports), a job UI that edits or
  retries jobs, and running jobs on more than one database.
