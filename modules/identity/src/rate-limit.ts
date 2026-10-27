import type { Database } from '@muziris/db';
import { lt, sql } from 'drizzle-orm';
import { rateLimits } from './db/schema.js';

export interface RateLimitResult {
  allowed: boolean;
  /** Hits counted in the current window, including this one. */
  hits: number;
  /** Seconds until the window resets; meaningful when not allowed. */
  retryAfterSeconds: number;
}

/**
 * Counts one hit against a key in a fixed window and says whether it is within the limit.
 * A single atomic upsert, so concurrent requests on several processes count correctly.
 */
export async function consumeRateLimit(
  db: Database,
  key: string,
  limit: number,
  windowMs: number,
  now: Date,
): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('limit must be a positive integer');
  if (!Number.isInteger(windowMs) || windowMs < 1000)
    throw new RangeError('windowMs must be at least 1000');

  // Raw SQL fragments do not get column type mapping, so pass an ISO string with a cast.
  const windowStart = sql`${new Date(now.getTime() - windowMs).toISOString()}::timestamptz`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key: key.slice(0, 256), windowStartedAt: now, hits: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStartedAt: sql`case when ${rateLimits.windowStartedAt} <= ${windowStart}
          then excluded.window_started_at else ${rateLimits.windowStartedAt} end`,
        hits: sql`case when ${rateLimits.windowStartedAt} <= ${windowStart}
          then 1 else ${rateLimits.hits} + 1 end`,
      },
    })
    .returning({ hits: rateLimits.hits, windowStartedAt: rateLimits.windowStartedAt });
  if (!row) throw new Error('Rate limit upsert returned no row');

  const resetsAt = row.windowStartedAt.getTime() + windowMs;
  return {
    allowed: row.hits <= limit,
    hits: row.hits,
    retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now.getTime()) / 1000)),
  };
}

/** Removes counters whose window ended before the cutoff. Meant for a periodic background job. */
export async function pruneRateLimits(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStartedAt, olderThan))
    .returning({ key: rateLimits.key });
  return deleted.length;
}
