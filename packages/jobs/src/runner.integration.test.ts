import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_NAMES, type JobName } from './names.js';
import { installJobSchema, startJobRunner, type JobHandler, type JobRunner } from './runner.js';

// The runner against PostgreSQL (ADR 0025): pg-boss's schema, enqueueing inside the caller's
// transaction, and a worker running what was enqueued.

const base = process.env['TEST_DATABASE_URL'];
const silent = { info: () => undefined, error: () => undefined };

/** A database of this file's own, made fresh: pg-boss's schema is outside the truncated tables. */
async function freshDatabase(baseUrl: string): Promise<string> {
  const url = new URL(baseUrl);
  const name = `${url.pathname.slice(1)}_jobs`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  url.pathname = `/${name}`;
  return url.toString();
}

describe.skipIf(!base)('job runner against PostgreSQL', () => {
  let url: string;
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    url = await freshDatabase(base!);
    await installJobSchema(url);
    // Installing again changes nothing.
    await installJobSchema(url);
    client = postgres(url, { max: 2, onnotice: () => undefined });
    db = drizzle(client);
    await db.execute(sql`create table change (id serial primary key)`);
  }, 30_000);

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  async function jobCount(name: JobName): Promise<number> {
    const rows = await db.execute<{ count: string }>(
      sql`select count(*) as count from pgboss.job where name = ${name}`,
    );
    return Number(rows[0]?.count);
  }

  it('creates a queue for every job', async () => {
    const rows = await db.execute<{ name: string }>(sql`select name from pgboss.queue`);
    expect(rows.map((r) => r.name).sort()).toEqual([...JOB_NAMES].sort());
  });

  it('enqueues in the transaction of the change, so a rollback enqueues nothing', async () => {
    const runner = await startJobRunner({ url, logger: silent });
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`insert into change default values`);
          await runner.queue.enqueue('pricing.build', { db: tx, delaySeconds: 60 });
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await jobCount('pricing.build')).toBe(0);

      await db.transaction(async (tx) => {
        await tx.execute(sql`insert into change default values`);
        await runner.queue.enqueue('pricing.build', { db: tx, delaySeconds: 60 });
      });
      expect(await jobCount('pricing.build')).toBe(1);
      expect(await runner.queue.status('pricing.build')).toBe('queued');

      // A build already waits, so a burst of edits adds nothing.
      await runner.queue.enqueue('pricing.build', { delaySeconds: 60 });
      expect(await jobCount('pricing.build')).toBe(1);
      expect((await runner.queue.list()).queued.map((j) => j.name)).toEqual(['pricing.build']);
    } finally {
      await runner.stop();
    }
  });

  it('runs an enqueued job in a worker', async () => {
    const ran: JobName[] = [];
    const handlers = Object.fromEntries(
      JOB_NAMES.map((name): [JobName, JobHandler] => [
        name,
        () => {
          ran.push(name);
          return Promise.resolve();
        },
      ]),
    ) as Record<JobName, JobHandler>;
    let runner: JobRunner | undefined;
    try {
      runner = await startJobRunner({ url, logger: silent, handlers });
      await runner.queue.enqueue('search.build');
      await expect.poll(() => ran.includes('search.build'), { timeout: 15_000 }).toBe(true);
      await expect
        .poll(() => runner?.queue.status('search.build'), { timeout: 5_000 })
        .toBe('idle');
    } finally {
      await runner?.stop();
    }
  }, 30_000);

  it('logs a failed job’s error and keeps only a pointer to it in pg-boss’s table', async () => {
    const secret = 'asha@example.com';
    const logged: unknown[] = [];
    const logger = {
      info: () => undefined,
      error: (fields: Record<string, unknown>) => {
        logged.push(fields['err']);
      },
    };
    const handlers = Object.fromEntries(
      JOB_NAMES.map((name): [JobName, JobHandler] => [
        name,
        () => Promise.reject(new Error(`Failed query: params: ${secret}`)),
      ]),
    ) as Record<JobName, JobHandler>;
    let runner: JobRunner | undefined;
    try {
      runner = await startJobRunner({ url, logger, handlers });
      await runner.queue.enqueue('visibility.build');
      await expect.poll(() => logged.length, { timeout: 15_000 }).toBeGreaterThan(0);
      expect(String(logged[0])).toContain(secret);
      await expect
        .poll(
          async () =>
            (
              await db.execute<{ output: unknown }>(
                sql`select output from pgboss.job where name = 'visibility.build' and output is not null`,
              )
            ).length,
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0);
      const rows = await db.execute<{ output: unknown }>(
        sql`select output from pgboss.job where name = 'visibility.build'`,
      );
      const stored = JSON.stringify(rows.map((r) => r.output));
      expect(stored).not.toContain(secret);
      expect(stored).toContain('see jobs.failed in the logs');
    } finally {
      await runner?.stop();
    }
  }, 30_000);
});
