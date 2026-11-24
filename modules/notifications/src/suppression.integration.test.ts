import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addSuppression,
  applyPostmarkEvent,
  findSuppression,
  listEmails,
  listSuppressions,
  queueEmail,
  readPostmarkEvent,
  removeSuppression,
  sendDueEmails,
  type MailMessage,
  type MailTransport,
} from './index.js';

// The suppression list and bounces (ADR 0032).

const url = process.env['TEST_DATABASE_URL'];
const NOW = new Date('2026-11-24T06:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const MESSAGE = { subject: 'Order MZ-000042 received', text: 'Hello', html: '<p>Hello</p>' };

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

/** What nodemailer throws when the relay refuses the only recipient (EENVELOPE on RCPT TO). */
function recipientRefused(responseCode: number): Error {
  return Object.assign(new Error(`Can't send mail: ${String(responseCode)} asha@example.in`), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode,
  });
}

/** A Postmark bounce webhook body, as its documentation shows it. */
function bounce(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RecordType: 'Bounce',
    MessageStream: 'outbound',
    ID: 692560173,
    Type: 'HardBounce',
    TypeCode: 1,
    Name: 'Hard bounce',
    Tag: '',
    MessageID: '883953f4-6105-42a2-a16a-77a8eac79483',
    Metadata: {},
    ServerID: 23,
    Description: 'The server was unable to deliver your message (ex: unknown user).',
    Details: 'smtp;550 5.1.1 asha@example.in does not exist',
    Email: 'Asha@Example.in',
    From: 'orders@example.com',
    BouncedAt: '2026-11-24T06:05:00.9070259Z',
    DumpAvailable: false,
    Inactive: true,
    CanActivate: true,
    Subject: MESSAGE.subject,
    ...fields,
  };
}

describe.skipIf(!url)('suppressed addresses and bounces against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'suppression');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate notification_outbox, notification_suppression, notification_bounce_event`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  const queue = (key: string, to = 'asha@example.in', sensitive = false) =>
    queueEmail(handle.db, {
      kind: 'order_placed',
      key,
      to,
      locale: 'en-IN',
      message: MESSAGE,
      now: NOW,
      sensitive,
    });

  const onlyEmail = async () => {
    const { emails } = await listEmails(handle.db);
    expect(emails).toHaveLength(1);
    return emails[0]!;
  };

  const read = (body: Record<string, unknown>) => {
    const event = readPostmarkEvent(JSON.stringify(body));
    if (event === undefined) throw new Error('unreadable test event');
    return event;
  };

  it('gives each email its outbox id, so a bounce can find it', async () => {
    await queue('order_placed:1');
    const transport = fakeTransport();
    await sendDueEmails(handle.db, transport, NOW);
    expect(transport.sent[0]?.outboxId).toBe((await onlyEmail()).id);
  });

  it('does not send to a suppressed address, and says so on the email', async () => {
    await addSuppression(handle.db, { email: 'ASHA@example.in', reason: 'manual', now: NOW });
    await queue('order_placed:1', 'asha@example.in', true);
    const transport = fakeTransport();
    expect(await sendDueEmails(handle.db, transport, NOW)).toMatchObject({
      sent: 0,
      suppressed: 1,
    });
    expect(transport.sent).toHaveLength(0);
    expect(await onlyEmail()).toMatchObject({ status: 'suppressed', attempts: 0, sentAt: null });
    // A secret in a suppressed email is not kept either.
    const [row] = await handle.db.execute<{ text_body: string }>(
      sql`select text_body from notification_outbox`,
    );
    expect(row?.text_body).toBe('');
  });

  it('fails at once and suppresses the address when the relay refuses the recipient', async () => {
    await queue('order_placed:1');
    const transport = fakeTransport();
    transport.failWith = recipientRefused(550);
    const result = await sendDueEmails(handle.db, transport, NOW);
    expect(result).toMatchObject({ sent: 0, retrying: 0 });
    expect(result.failed).toHaveLength(1);
    const email = await onlyEmail();
    expect(email).toMatchObject({ status: 'failed', attempts: 1, lastError: 'smtp_550' });
    expect(await findSuppression(handle.db, 'asha@example.in')).toMatchObject({
      reason: 'smtp_rejected',
      source: 'smtp',
      outboxId: email.id,
    });
  });

  it('retries a refusal that is temporary or about our setup, and suppresses nothing', async () => {
    await queue('order_placed:1');
    await queue('order_placed:2', 'ravi@example.in');
    await queue('order_placed:3', 'meena@example.in');
    const transport = fakeTransport();
    for (const failure of [
      recipientRefused(450),
      Object.assign(new Error('auth'), { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }),
      Object.assign(new Error('data'), { code: 'EMESSAGE', command: 'DATA', responseCode: 554 }),
    ]) {
      transport.failWith = failure;
      expect(await sendDueEmails(handle.db, transport, NOW, { limit: 1 })).toMatchObject({
        retrying: 1,
      });
    }
    expect((await listSuppressions(handle.db)).suppressions).toHaveLength(0);
  });

  it('reads a bounce and a spam complaint, and ignores records it does not handle', () => {
    expect(read(bounce({ Metadata: { 'outbox-id': 'x' } }))).toEqual({
      kind: 'bounce',
      id: 692560173,
      type: 'HardBounce',
      typeCode: 1,
      email: 'asha@example.in',
      inactive: true,
      outboxId: 'x',
    });
    expect(
      read(bounce({ RecordType: 'SpamComplaint', Type: 'SpamComplaint', TypeCode: 100001 })),
    ).toMatchObject({ kind: 'spam_complaint', type: 'SpamComplaint', typeCode: 100001 });
    expect(read({ RecordType: 'Delivery', MessageID: 'm' })).toEqual({ kind: 'ignored' });
    expect(readPostmarkEvent('not json')).toBeUndefined();
    expect(readPostmarkEvent(JSON.stringify(bounce({ ID: 'seven' })))).toBeUndefined();
    expect(readPostmarkEvent(JSON.stringify(bounce({ Email: 'nobody' })))).toBeUndefined();
  });

  it('marks the email bounced and suppresses the address after a hard bounce', async () => {
    await queue('order_placed:1');
    await sendDueEmails(handle.db, fakeTransport(), NOW);
    const sent = await onlyEmail();
    const result = await applyPostmarkEvent(
      handle.db,
      read(bounce({ Metadata: { 'outbox-id': sent.id } })),
      minutes(5),
    );
    expect(result).toEqual({ outcome: 'recorded', suppressed: true, outboxId: sent.id });
    expect(await onlyEmail()).toMatchObject({
      status: 'bounced',
      bounceType: 'HardBounce',
      sentAt: NOW,
    });
    const suppression = await findSuppression(handle.db, 'asha@example.in');
    expect(suppression).toMatchObject({
      reason: 'hard_bounce',
      source: 'postmark',
      bounceType: 'HardBounce',
      bounceTypeCode: 1,
      outboxId: sent.id,
      firstSeenAt: minutes(5),
    });
    // Neither Postmark's description nor its details are kept.
    const stored = JSON.stringify(
      await handle.db.execute(
        sql`select * from notification_suppression, notification_bounce_event`,
      ),
    );
    expect(stored).not.toContain('does not exist');
    expect(stored).not.toContain('unable to deliver');
  });

  it('suppresses after a spam complaint, a bad address or any bounce that deactivated it', async () => {
    const cases = [
      { ID: 1, RecordType: 'SpamComplaint', Type: 'SpamComplaint', TypeCode: 100001 },
      { ID: 2, Type: 'BadEmailAddress', TypeCode: 100000, Inactive: false },
      { ID: 3, Type: 'ManuallyDeactivated', TypeCode: 100002, Inactive: false },
      { ID: 4, Type: 'SpamNotification', TypeCode: 512, Inactive: false },
      { ID: 5, Type: 'Blocked', TypeCode: 100006, Inactive: true },
    ];
    for (const [i, fields] of cases.entries()) {
      const email = `buyer${String(i)}@example.in`;
      const result = await applyPostmarkEvent(
        handle.db,
        read(bounce({ ...fields, Email: email })),
        NOW,
      );
      expect(result).toMatchObject({ suppressed: true });
    }
    const { suppressions } = await listSuppressions(handle.db);
    expect(suppressions.map((s) => [s.email, s.reason]).sort()).toEqual([
      ['buyer0@example.in', 'spam_complaint'],
      ['buyer1@example.in', 'hard_bounce'],
      ['buyer2@example.in', 'hard_bounce'],
      ['buyer3@example.in', 'hard_bounce'],
      ['buyer4@example.in', 'hard_bounce'],
    ]);
  });

  it('records a soft bounce on the email only', async () => {
    await queue('order_placed:1');
    await sendDueEmails(handle.db, fakeTransport(), NOW);
    const sent = await onlyEmail();
    const result = await applyPostmarkEvent(
      handle.db,
      read(
        bounce({
          Type: 'SoftBounce',
          TypeCode: 4096,
          Inactive: false,
          Metadata: { 'outbox-id': sent.id },
        }),
      ),
      minutes(5),
    );
    expect(result).toEqual({ outcome: 'recorded', suppressed: false, outboxId: sent.id });
    expect(await onlyEmail()).toMatchObject({ status: 'bounced', bounceType: 'SoftBounce' });
    expect(await findSuppression(handle.db, 'asha@example.in')).toBeUndefined();
  });

  it('records each Postmark event once', async () => {
    const event = read(bounce());
    expect(await applyPostmarkEvent(handle.db, event, NOW)).toMatchObject({ outcome: 'recorded' });
    expect(await applyPostmarkEvent(handle.db, event, minutes(1))).toEqual({
      outcome: 'duplicate',
    });
    const suppression = await findSuppression(handle.db, 'asha@example.in');
    expect(suppression?.lastSeenAt).toEqual(NOW);
  });

  it('suppresses the address of a bounce whose email it cannot find', async () => {
    const result = await applyPostmarkEvent(
      handle.db,
      read(bounce({ Metadata: { 'outbox-id': '00000000-0000-4000-8000-000000000000' } })),
      NOW,
    );
    expect(result).toEqual({ outcome: 'recorded', suppressed: true, outboxId: null });
    expect(await findSuppression(handle.db, 'asha@example.in')).toMatchObject({ outboxId: null });
  });

  it('does not mark an email bounced that was never sent', async () => {
    await queue('order_placed:1');
    const queued = await onlyEmail();
    await applyPostmarkEvent(
      handle.db,
      read(bounce({ Metadata: { 'outbox-id': queued.id } })),
      NOW,
    );
    expect(await onlyEmail()).toMatchObject({ status: 'queued', bounceType: null });
  });

  it('keeps the first time an address was seen and updates the last', async () => {
    await addSuppression(handle.db, { email: 'asha@example.in', reason: 'manual', now: NOW });
    await applyPostmarkEvent(handle.db, read(bounce()), minutes(10));
    expect(await findSuppression(handle.db, 'asha@example.in')).toMatchObject({
      reason: 'manual',
      firstSeenAt: NOW,
      lastSeenAt: minutes(10),
    });
  });

  it('lets an admin add, search, page and remove suppressed addresses', async () => {
    for (const [i, email] of ['a@example.in', 'b@example.in', 'c@other.in'].entries()) {
      await addSuppression(handle.db, { email, reason: 'manual', now: minutes(i) });
    }
    const first = await listSuppressions(handle.db, { limit: 2 });
    expect(first.suppressions.map((s) => s.email)).toEqual(['c@other.in', 'b@example.in']);
    const second = await listSuppressions(handle.db, {
      limit: 2,
      after: first.nextAfter ?? undefined,
    });
    expect(second.suppressions.map((s) => s.email)).toEqual(['a@example.in']);
    expect(second.nextAfter).toBeNull();
    const found = await listSuppressions(handle.db, { search: 'EXAMPLE.in' });
    expect(found.suppressions.map((s) => s.email)).toEqual(['b@example.in', 'a@example.in']);
    // A LIKE wildcard in the search is taken literally.
    expect((await listSuppressions(handle.db, { search: '%' })).suppressions).toHaveLength(0);

    const removed = await removeSuppression(handle.db, first.suppressions[0]!.id);
    expect(removed.email).toBe('c@other.in');
    await expect(removeSuppression(handle.db, removed.id)).rejects.toMatchObject({
      code: 'suppression_not_found',
    });
    await expect(
      addSuppression(handle.db, { email: 'not an address', reason: 'manual', now: NOW }),
    ).rejects.toMatchObject({ code: 'suppression_invalid_email' });
  });

  it('sends again once an address is removed from the list', async () => {
    const added = await addSuppression(handle.db, {
      email: 'asha@example.in',
      reason: 'manual',
      now: NOW,
    });
    await removeSuppression(handle.db, added.id);
    await queue('order_placed:1');
    expect(await sendDueEmails(handle.db, fakeTransport(), NOW)).toMatchObject({ sent: 1 });
  });
});
