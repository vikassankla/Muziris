import type { Database } from '@muziris/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  bounceEvent,
  outbox,
  suppression,
  type SuppressionReason,
  type SuppressionSource,
} from './db/schema.js';
import type { Executor } from './outbox.js';

// The suppression list (ADR 0032): addresses Muziris does not send to. The sender checks it
// before each email; Postmark's webhooks, the relay's refusals and admins add to it.

export type SuppressionErrorCode = 'suppression_not_found' | 'suppression_invalid_email';

export class SuppressionError extends Error {
  readonly code: SuppressionErrorCode;

  constructor(code: SuppressionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SuppressionError';
  }
}

export interface Suppression {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  bounceType: string | null;
  bounceTypeCode: number | null;
  outboxId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function toSuppression(row: typeof suppression.$inferSelect): Suppression {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason as SuppressionReason,
    source: row.source as SuppressionSource,
    bounceType: row.bounceType,
    bounceTypeCode: row.bounceTypeCode,
    outboxId: row.outboxId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

/** Lowercased and trimmed, or undefined when it is not shaped like an address. */
export function normalizeEmail(email: string): string | undefined {
  const value = email.trim().toLowerCase();
  return value.length <= 320 && EMAIL_SHAPE.test(value) ? value : undefined;
}

interface SuppressInput {
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  bounceType?: string | null;
  bounceTypeCode?: number | null;
  outboxId?: string | null;
  now: Date;
}

/**
 * Puts an address on the list. An address already there keeps its first reason and first time;
 * only the last time it was seen moves on.
 */
export async function suppressAddress(db: Executor, input: SuppressInput): Promise<Suppression> {
  const email = normalizeEmail(input.email);
  if (email === undefined) {
    throw new SuppressionError('suppression_invalid_email', 'Enter an email address');
  }
  const [row] = await db
    .insert(suppression)
    .values({
      email,
      reason: input.reason,
      source: input.source,
      bounceType: input.bounceType ?? null,
      bounceTypeCode: input.bounceTypeCode ?? null,
      outboxId: input.outboxId ?? null,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
    })
    .onConflictDoUpdate({
      target: suppression.email,
      set: { lastSeenAt: sql`greatest(${suppression.lastSeenAt}, excluded.last_seen_at)` },
    })
    .returning();
  if (!row) throw new Error('suppression upsert returned nothing');
  return toSuppression(row);
}

/** An admin adds an address, such as one whose owner asked not to be mailed. */
export function addSuppression(
  db: Executor,
  input: { email: string; reason: 'manual'; now: Date },
): Promise<Suppression> {
  return suppressAddress(db, { ...input, source: 'admin' });
}

export async function findSuppression(
  db: Executor,
  email: string,
): Promise<Suppression | undefined> {
  const normalized = normalizeEmail(email);
  if (normalized === undefined) return undefined;
  const [row] = await db
    .select()
    .from(suppression)
    .where(eq(suppression.email, normalized))
    .limit(1);
  return row ? toSuppression(row) : undefined;
}

/** Removes an address from Muziris's list only; Postmark keeps its own deactivation. */
export async function removeSuppression(db: Database, suppressionId: string): Promise<Suppression> {
  const id = z.uuid().safeParse(suppressionId);
  const [row] = id.success
    ? await db.delete(suppression).where(eq(suppression.id, id.data)).returning()
    : [];
  if (!row) throw new SuppressionError('suppression_not_found', 'No such suppressed address');
  return toSuppression(row);
}

const listQuerySchema = z.object({
  search: z.string().trim().max(320).optional(),
  after: z.uuid().optional(),
  limit: z.int().min(1).max(100).default(50),
});

export type ListSuppressionsQuery = z.input<typeof listQuerySchema>;

export interface SuppressionPage {
  suppressions: Suppression[];
  nextAfter: string | null;
}

/** Suppressed addresses, newest first, by page, optionally those containing a search text. */
export async function listSuppressions(
  db: Database,
  query: ListSuppressionsQuery = {},
): Promise<SuppressionPage> {
  const q = listQuerySchema.parse(query);
  const search = q.search === undefined || q.search === '' ? undefined : q.search.toLowerCase();
  const pattern = search === undefined ? undefined : `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await db
    .select()
    .from(suppression)
    .where(
      and(
        pattern === undefined ? undefined : sql`${suppression.email} like ${pattern}`,
        q.after === undefined
          ? undefined
          : sql`(${suppression.firstSeenAt}, ${suppression.id}) < (select first_seen_at, id from ${suppression} where id = ${q.after})`,
      ),
    )
    .orderBy(desc(suppression.firstSeenAt), desc(suppression.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  return {
    suppressions: page.map(toSuppression),
    nextAfter: more ? (page.at(-1)?.id ?? null) : null,
  };
}

// Postmark's bounce and spam complaint webhooks. Field names as Postmark documents them
// (checked 2026-11-24): RecordType, ID, Type, TypeCode, Email, Inactive, Metadata.

/** Bounce types that mean the address will not take mail. Any bounce with Inactive does too. */
const PERMANENT_BOUNCE_TYPES = new Set([
  'HardBounce',
  'BadEmailAddress',
  'ManuallyDeactivated',
  'SpamNotification',
]);

/** The metadata key the sender sets through the X-PM-Metadata-outbox-id header. */
export const OUTBOX_METADATA_KEY = 'outbox-id';

export type PostmarkEvent =
  | { kind: 'ignored' }
  | {
      kind: 'bounce' | 'spam_complaint';
      id: number;
      type: string;
      typeCode: number;
      email: string;
      inactive: boolean;
      outboxId: string | null;
    };

const recordSchema = z.object({ RecordType: z.string() });

const bounceSchema = z.object({
  RecordType: z.enum(['Bounce', 'SpamComplaint']),
  ID: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  Type: z.string().regex(/^[A-Za-z]{1,40}$/),
  TypeCode: z.int().min(0),
  Email: z.string().max(320),
  Inactive: z.boolean().optional(),
  Metadata: z.record(z.string(), z.unknown()).nullish(),
});

/** Reads a webhook body. Undefined when it is not JSON or not a record Postmark documents. */
export function readPostmarkEvent(rawBody: string): PostmarkEvent | undefined {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  const record = recordSchema.safeParse(body);
  if (!record.success) return undefined;
  if (record.data.RecordType !== 'Bounce' && record.data.RecordType !== 'SpamComplaint') {
    return { kind: 'ignored' };
  }
  const parsed = bounceSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const email = normalizeEmail(parsed.data.Email);
  if (email === undefined) return undefined;
  // Header names are case-insensitive, so the key may come back in another case.
  const metadata = Object.entries(parsed.data.Metadata ?? {}).find(
    ([key]) => key.toLowerCase() === OUTBOX_METADATA_KEY,
  )?.[1];
  return {
    kind: parsed.data.RecordType === 'SpamComplaint' ? 'spam_complaint' : 'bounce',
    id: parsed.data.ID,
    type: parsed.data.Type,
    typeCode: parsed.data.TypeCode,
    email,
    inactive: parsed.data.Inactive ?? false,
    outboxId: typeof metadata === 'string' ? metadata : null,
  };
}

export type PostmarkEventResult =
  | { outcome: 'ignored' }
  | { outcome: 'duplicate' }
  | { outcome: 'recorded'; suppressed: boolean; outboxId: string | null };

/**
 * Applies a bounce or spam complaint, once per Postmark ID (any other record is ignored): marks the email it is about as
 * bounced, and suppresses the address when the bounce is permanent or a spam complaint.
 */
export async function applyPostmarkEvent(
  db: Database,
  event: PostmarkEvent,
  now: Date,
): Promise<PostmarkEventResult> {
  if (event.kind === 'ignored') return { outcome: 'ignored' };
  const outboxId = z.uuid().safeParse(event.outboxId).success ? event.outboxId : null;
  return db.transaction(async (tx) => {
    const recorded = await tx
      .insert(bounceEvent)
      .values({
        postmarkId: event.id,
        recordType: event.kind === 'spam_complaint' ? 'SpamComplaint' : 'Bounce',
        bounceType: event.type,
        bounceTypeCode: event.typeCode,
        outboxId,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: bounceEvent.postmarkId });
    if (recorded.length === 0) return { outcome: 'duplicate' as const };

    const [marked] =
      outboxId === null
        ? []
        : await tx
            .update(outbox)
            .set({ status: 'bounced', bounceType: event.type, updatedAt: now })
            .where(and(eq(outbox.id, outboxId), inArray(outbox.status, ['sent', 'bounced'])))
            .returning({ id: outbox.id });

    const reason: SuppressionReason | undefined =
      event.kind === 'spam_complaint'
        ? 'spam_complaint'
        : PERMANENT_BOUNCE_TYPES.has(event.type) || event.inactive
          ? 'hard_bounce'
          : undefined;
    if (reason !== undefined) {
      await suppressAddress(tx, {
        email: event.email,
        reason,
        source: 'postmark',
        bounceType: event.type,
        bounceTypeCode: event.typeCode,
        outboxId: marked?.id ?? null,
        now,
      });
    }
    return {
      outcome: 'recorded' as const,
      suppressed: reason !== undefined,
      outboxId: marked?.id ?? null,
    };
  });
}
