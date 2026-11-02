import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listEmails,
  MAX_ATTEMPTS,
  queueEmail,
  retryEmail,
  sendDueEmails,
  type MailMessage,
  type MailTransport,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];
const NOW = new Date('2026-11-20T06:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const MESSAGE = { subject: 'Order MZ-000042 received', text: 'Hello', html: '<p>Hello</p>' };

/** A mail server that records what it was given, and can be made to refuse. */
function fakeTransport(): MailTransport & { sent: MailMessage[]; failWith?: Error } {
  const transport: MailTransport & { sent: MailMessage[]; failWith?: Error } = {
    sent: [],
    send(message) {
      if (transport.failWith !== undefined) return Promise.reject(transport.failWith);
      transport.sent.push(message);
      return Promise.resolve();
    },
  };
  return transport;
}

describe.skipIf(!url)('the notification outbox against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'notifications');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(sql`truncate notification_outbox`);
  });

  afterAll(async () => {
    await handle.close();
  });

  const queue = (key: string, extra: { sensitive?: boolean; to?: string } = {}) =>
    queueEmail(handle.db, {
      kind: 'order_placed',
      key,
      to: extra.to ?? 'Asha@Example.in',
      locale: 'en-IN',
      message: MESSAGE,
      now: NOW,
      ...(extra.sensitive === undefined ? {} : { sensitive: extra.sensitive }),
    });

  const bodies = async () =>
    (
      await handle.db.execute<{ text_body: string; html_body: string }>(
        sql`select text_body, html_body from notification_outbox`,
      )
    ).map((r) => [r.text_body, r.html_body]);

  it('queues an email once per key', async () => {
    expect(await queue('order_placed:1')).toBe(true);
    expect(await queue('order_placed:1')).toBe(false);
    const { emails } = await listEmails(handle.db);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ recipient: 'asha@example.in', status: 'queued' });
  });

  it('queues nothing when the change it belongs to rolls back', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await queueEmail(tx, {
          kind: 'order_placed',
          key: 'order_placed:rolled-back',
          to: 'asha@example.in',
          locale: 'en-IN',
          message: MESSAGE,
          now: NOW,
        });
        throw new Error('the order insert failed');
      }),
    ).rejects.toThrow('the order insert failed');
    expect((await listEmails(handle.db)).emails).toHaveLength(0);
  });

  it('sends due emails and marks them sent', async () => {
    await queue('order_placed:1');
    const transport = fakeTransport();
    expect(await sendDueEmails(handle.db, transport, NOW)).toEqual({
      sent: 1,
      retrying: 0,
      failed: [],
    });
    expect(transport.sent).toEqual([{ to: 'asha@example.in', ...MESSAGE }]);
    const [email] = (await listEmails(handle.db, { status: 'sent' })).emails;
    expect(email).toMatchObject({ attempts: 1, sentAt: NOW, lastError: null });
    expect(await sendDueEmails(handle.db, transport, minutes(1))).toMatchObject({ sent: 0 });
    // A body without secrets stays for the log.
    expect(await bodies()).toEqual([['Hello', '<p>Hello</p>']]);
  });

  it('empties the body of an email that carried a secret, once it is sent', async () => {
    await queue('buyer_invitation:1', { sensitive: true });
    await sendDueEmails(handle.db, fakeTransport(), NOW);
    expect(await bodies()).toEqual([['', '']]);
    const [email] = (await listEmails(handle.db)).emails;
    expect(email?.subject).toBe(MESSAGE.subject);
  });

  it('retries with backoff, then gives up after five attempts and keeps only the error code', async () => {
    await queue('order_placed:1', { sensitive: true });
    const transport = fakeTransport();
    transport.failWith = Object.assign(new Error('550 asha@example.in: no such user'), {
      responseCode: 550,
    });
    let at = NOW;
    for (const delay of [1, 5, 30, 120]) {
      expect(await sendDueEmails(handle.db, transport, at)).toMatchObject({ retrying: 1 });
      // Not due again before its delay.
      expect(
        await sendDueEmails(handle.db, transport, new Date(at.getTime() + delay * 60_000 - 1)),
      ).toMatchObject({ sent: 0, retrying: 0 });
      at = new Date(at.getTime() + delay * 60_000);
    }
    const last = await sendDueEmails(handle.db, transport, at);
    expect(last.failed).toHaveLength(1);
    expect(last.failed[0]).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lastError: 'smtp_550',
    });
    expect(JSON.stringify(await listEmails(handle.db))).not.toContain('no such user');
    expect(await bodies()).toEqual([['', '']]);
  });

  it('sends a failed email again on request, unless its body was emptied', async () => {
    await queue('order_placed:1');
    await queue('buyer_invitation:1', { sensitive: true, to: 'ravi@example.in' });
    const transport = fakeTransport();
    transport.failWith = new Error('down');
    let at = NOW;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await sendDueEmails(handle.db, transport, at);
      at = minutes(1000 * (i + 1));
    }
    const failed = (await listEmails(handle.db, { status: 'failed' })).emails;
    expect(failed).toHaveLength(2);
    const plain = failed.find((e) => e.recipient === 'asha@example.in');
    const secret = failed.find((e) => e.recipient === 'ravi@example.in');
    await expect(retryEmail(handle.db, secret?.id ?? '', at)).rejects.toMatchObject({
      code: 'notification_body_discarded',
    });
    const again = await retryEmail(handle.db, plain?.id ?? '', at);
    expect(again).toMatchObject({ status: 'queued', attempts: 0, lastError: null });
    await expect(retryEmail(handle.db, again.id, at)).rejects.toMatchObject({
      code: 'notification_not_failed',
    });
    delete transport.failWith;
    expect(await sendDueEmails(handle.db, transport, at)).toMatchObject({ sent: 1 });
  });

  it('never sends an email twice when two senders run at once', async () => {
    for (let i = 0; i < 20; i += 1) await queue(`order_placed:${String(i)}`);
    const transport = fakeTransport();
    const slow: MailTransport = {
      send: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await transport.send(message);
      },
    };
    const results = await Promise.all([
      sendDueEmails(handle.db, slow, NOW),
      sendDueEmails(handle.db, slow, NOW),
      sendDueEmails(handle.db, slow, NOW),
    ]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(20);
    expect(transport.sent).toHaveLength(20);
  });

  it('pages through emails newest first', async () => {
    for (let i = 0; i < 3; i += 1) {
      await queueEmail(handle.db, {
        kind: 'order_placed',
        key: `k${String(i)}`,
        to: 'asha@example.in',
        locale: 'en-IN',
        message: { ...MESSAGE, subject: `s${String(i)}` },
        now: minutes(i),
      });
    }
    const first = await listEmails(handle.db, { limit: 2 });
    expect(first.emails.map((e) => e.subject)).toEqual(['s2', 's1']);
    const second = await listEmails(handle.db, { limit: 2, after: first.nextAfter ?? undefined });
    expect(second.emails.map((e) => e.subject)).toEqual(['s0']);
    expect(second.nextAfter).toBeNull();
  });
});
