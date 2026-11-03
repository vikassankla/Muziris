import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { startJobRunner, type JobRunner } from '@muziris/jobs';
import { createPriceList, getBuildState, listPriceLists } from '@muziris/pricing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jobHandlers, writeAndBuild } from './jobs.js';
import { createLogger } from './logger.js';

// A write and its build in one transaction, and the handlers the workers run (ADR 0025).

const url = process.env['TEST_DATABASE_URL'];
const logger = createLogger('silent');

describe.skipIf(!url)('jobs against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let runner: JobRunner;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_jobs');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
    // Enqueue only: no workers, so the queued jobs stay where the test can see them.
    runner = await startJobRunner({ url: testUrl, logger });
  });

  beforeEach(async () => {
    const tables = await handle.db.execute<{ name: string }>(
      sql`select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
    );
    await handle.db.execute(
      sql.raw(`truncate ${tables.map((t) => t.name).join(', ')} restart identity cascade`),
    );
    await handle.db.execute(sql`delete from pgboss.job`);
  });

  afterAll(async () => {
    await runner.stop();
    await handle.close();
  });

  const deps = () => ({ db: handle.db, jobs: runner.queue });

  it('enqueues the build with its write, to start after a short wait', async () => {
    await writeAndBuild(deps(), ['pricing.build'], (db) =>
      createPriceList(db, { name: 'List price', currency: 'INR' }),
    );
    expect(await runner.queue.status('pricing.build')).toBe('queued');
    const [job] = (await runner.queue.list()).queued;
    expect(job?.name).toBe('pricing.build');
    expect(job!.startAfter.getTime() - job!.createdAt.getTime()).toBeGreaterThanOrEqual(14_000);
  });

  it('enqueues nothing when the write rolls back', async () => {
    await expect(
      writeAndBuild(deps(), ['pricing.build'], async (db) => {
        await createPriceList(db, { name: 'List price', currency: 'INR' });
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect((await listPriceLists(handle.db, {}, new Date())).priceLists).toHaveLength(0);
    expect(await runner.queue.status('pricing.build')).toBe('idle');
  });

  it('builds prices as the system when the worker runs the job', async () => {
    await createPriceList(handle.db, { name: 'List price', currency: 'INR' });
    await jobHandlers({ db: handle.db, logger })['pricing.build']();
    expect((await getBuildState(handle.db)).lastBuild).toMatchObject({ builtBy: null });
  });
});
