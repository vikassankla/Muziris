import type { Database, Transaction } from '@muziris/db';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { outbox, type NotificationKind, type OutboxStatus } from './db/schema.js';
import type { RenderedEmail } from './templates.js';

/** The database or an open transaction: an email is queued in the transaction of its change. */
export type Executor = Database | Transaction;

/** Minutes to wait after each failed attempt; the fifth failure gives up. */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

export type NotificationErrorCode =
  'notification_not_found' | 'notification_not_failed' | 'notification_body_discarded';

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'NotificationError';
  }
}

/** An outbox row as the admin sees it: never the body, which may have held a token. */
export interface OutboxEmail {
  id: string;
  kind: NotificationKind;
  recipient: string;
  locale: string;
  subject: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

function toEmail(row: typeof outbox.$inferSelect): OutboxEmail {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    recipient: row.recipient,
    locale: row.locale,
    subject: row.subject,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

export interface QueueEmailInput {
  kind: NotificationKind;
  /** Unique per email, such as order_placed:<order id>. */
  key: string;
  to: string;
  locale: string;
  message: RenderedEmail;
  /** The body carries a secret, such as an invitation link. */
  sensitive?: boolean;
  now: Date;
}

/**
 * Queues an email. Run it in the transaction of the change it reports. A key queued before is
 * left alone, so retrying the change never sends the email twice. True when this call queued it.
 */
export async function queueEmail(db: Executor, input: QueueEmailInput): Promise<boolean> {
  const rows = await db
    .insert(outbox)
    .values({
      kind: input.kind,
      idempotencyKey: input.key,
      recipient: input.to.trim().toLowerCase(),
      locale: input.locale,
      subject: input.message.subject,
      textBody: input.message.text,
      htmlBody: input.message.html,
      sensitive: input.sensitive ?? false,
      nextAttemptAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .returning({ id: outbox.id });
  return rows.length > 0;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends one message, or throws. A thrown `code` or `responseCode` is kept; the message is not. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/**
 * A short, safe reason for a failed send. SMTP replies can quote addresses, so the server's
 * text is never stored or logged: only nodemailer's error code or the SMTP reply code.
 */
export function sendErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
    if (typeof responseCode === 'number' && Number.isInteger(responseCode)) {
      return `smtp_${String(responseCode)}`;
    }
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code)) return code;
  }
  return 'send_failed';
}

export interface SendResult {
  sent: number;
  retrying: number;
  /** Emails that gave up on this run, for the caller to log. */
  failed: OutboxEmail[];
}

/**
 * Sends due emails, one per transaction. Each row is claimed with FOR UPDATE SKIP LOCKED, so
 * several API processes can run this at once without sending an email twice.
 */
export async function sendDueEmails(
  db: Database,
  transport: MailTransport,
  now: Date,
  options: { limit?: number } = {},
): Promise<SendResult> {
  const limit = options.limit ?? 50;
  const result: SendResult = { sent: 0, retrying: 0, failed: [] };
  for (let i = 0; i < limit; i += 1) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outbox)
        .where(and(eq(outbox.status, 'queued'), lte(outbox.nextAttemptAt, now)))
        .orderBy(asc(outbox.nextAttemptAt), asc(outbox.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return true;
      // A sent or abandoned secret does not stay in the database.
      const emptied = row.sensitive ? { textBody: '', htmlBody: '' } : {};
      try {
        await transport.send({
          to: row.recipient,
          subject: row.subject,
          text: row.textBody,
          html: row.htmlBody,
        });
      } catch (error) {
        const attempts = row.attempts + 1;
        const lastError = sendErrorCode(error);
        const delay = RETRY_DELAYS_MINUTES[attempts - 1];
        if (delay === undefined) {
          const [failed] = await tx
            .update(outbox)
            .set({ status: 'failed', attempts, lastError, updatedAt: now, ...emptied })
            .where(eq(outbox.id, row.id))
            .returning();
          if (failed) result.failed.push(toEmail(failed));
        } else {
          await tx
            .update(outbox)
            .set({
              attempts,
              lastError,
              nextAttemptAt: new Date(now.getTime() + delay * 60_000),
              updatedAt: now,
            })
            .where(eq(outbox.id, row.id));
          result.retrying += 1;
        }
        return false;
      }
      await tx
        .update(outbox)
        .set({
          status: 'sent',
          attempts: row.attempts + 1,
          sentAt: now,
          lastError: null,
          updatedAt: now,
          ...emptied,
        })
        .where(eq(outbox.id, row.id));
      result.sent += 1;
      return false;
    });
    if (done) break;
  }
  return result;
}

const listQuerySchema = z.object({
  status: z.enum(['queued', 'sent', 'failed']).optional(),
  after: z.uuid().optional(),
  limit: z.int().min(1).max(100).default(50),
});

export type ListEmailsQuery = z.input<typeof listQuerySchema>;

export interface EmailPage {
  emails: OutboxEmail[];
  nextAfter: string | null;
}

/** Emails, newest first, optionally of one status, by page. */
export async function listEmails(db: Database, query: ListEmailsQuery = {}): Promise<EmailPage> {
  const q = listQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(outbox)
    .where(
      and(
        q.status === undefined ? undefined : eq(outbox.status, q.status),
        q.after === undefined
          ? undefined
          : sql`(${outbox.createdAt}, ${outbox.id}) < (select created_at, id from ${outbox} where id = ${q.after})`,
      ),
    )
    .orderBy(desc(outbox.createdAt), desc(outbox.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  return { emails: page.map(toEmail), nextAfter: more ? (page.at(-1)?.id ?? null) : null };
}

/**
 * Queues a failed email again, from its first attempt. An email whose body held a secret was
 * emptied when it failed; it is refused here, and is sent again from where it started (for an
 * invitation, "send again", which makes a new token).
 */
export async function retryEmail(db: Database, emailId: string, now: Date): Promise<OutboxEmail> {
  const id = z.uuid().safeParse(emailId);
  if (!id.success) throw new NotificationError('notification_not_found', 'No such email');
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id.data)).limit(1);
  if (!row) throw new NotificationError('notification_not_found', 'No such email');
  if (row.status !== 'failed') {
    throw new NotificationError('notification_not_failed', 'Only a failed email can be sent again');
  }
  if (row.sensitive) {
    throw new NotificationError(
      'notification_body_discarded',
      'This email held a secret and was emptied; send the invitation again instead',
    );
  }
  const [updated] = await db
    .update(outbox)
    .set({ status: 'queued', attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now })
    .where(and(eq(outbox.id, row.id), eq(outbox.status, 'failed')))
    .returning();
  if (!updated) {
    throw new NotificationError('notification_not_failed', 'Only a failed email can be sent again');
  }
  return toEmail(updated);
}
