import { Writable } from 'node:stream';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import {
  findSuppression,
  listEmails,
  queueEmail,
  sendDueEmails,
  type PostmarkConfig,
} from '@muziris/notifications';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

// POST /webhooks/postmark (ADR 0032).

const url = process.env['TEST_DATABASE_URL'];
const NOW = new Date('2026-11-24T06:00:00.000Z');
const USER = 'muziris-postmark';
const PASSWORD = 'webhook-password-for-tests-0123456789';
const POSTMARK: PostmarkConfig = {
  messageStream: 'outbound',
  webhook: { user: USER, password: PASSWORD },
};

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

function bounceBody(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    RecordType: 'Bounce',
    MessageStream: 'outbound',
    ID: 692560173,
    Type: 'HardBounce',
    TypeCode: 1,
    Name: 'Hard bounce',
    MessageID: '883953f4-6105-42a2-a16a-77a8eac79483',
    Metadata: {},
    ServerID: 23,
    Description: 'The server was unable to deliver your message.',
    Details: 'smtp;550 5.1.1 user unknown',
    Email: 'asha@example.in',
    From: 'orders@example.com',
    BouncedAt: '2026-11-24T06:05:00Z',
    DumpAvailable: false,
    Inactive: true,
    CanActivate: true,
    Subject: 'Order received',
    ...fields,
  });
}

describe.skipIf(!url)('the Postmark webhook against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[] = [];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_postmark');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    logs = [];
    await handle.db.execute(
      sql`truncate notification_outbox, notification_suppression, notification_bounce_event, identity_rate_limit`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  function app(postmark: PostmarkConfig | undefined = POSTMARK) {
    return createApp({
      logger: createLogger(
        'info',
        new Writable({
          write: (chunk: Buffer, _e, done) => {
            logs.push(chunk.toString());
            done();
          },
        }),
      ),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [],
      maxBodyBytes: 1024 * 1024,
      now: () => NOW,
      clientIp: () => '50.31.156.6',
      postmark,
    });
  }

  const post = (
    body: string,
    authorization: string | null = basic(USER, PASSWORD),
    postmark?: PostmarkConfig,
  ) =>
    app(postmark).request('/webhooks/postmark', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization === null ? {} : { authorization }),
      },
      body,
    });

  const sentEmail = async () => {
    await queueEmail(handle.db, {
      kind: 'order_placed',
      key: 'order_placed:1',
      to: 'asha@example.in',
      locale: 'en-IN',
      message: { subject: 'Order received', text: 'Hello', html: '<p>Hello</p>' },
      now: NOW,
    });
    await sendDueEmails(handle.db, { send: () => Promise.resolve() }, NOW);
    const [email] = (await listEmails(handle.db)).emails;
    if (!email) throw new Error('no email');
    return email;
  };

  it('does not exist when no webhook credentials are set', async () => {
    const response = await post(bounceBody(), basic(USER, PASSWORD), {
      messageStream: 'outbound',
      webhook: undefined,
    });
    expect(response.status).toBe(404);
  });

  it('refuses a request without the right credentials, and records nothing', async () => {
    for (const authorization of [null, basic(USER, `${PASSWORD}x`), basic('other', PASSWORD)]) {
      const response = await post(bounceBody(), authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Basic realm="postmark"');
    }
    expect(await findSuppression(handle.db, 'asha@example.in')).toBeUndefined();
    expect(logs.join('')).not.toContain(PASSWORD);
  });

  it('marks the email bounced and suppresses the address, logging neither the address nor the details', async () => {
    const email = await sentEmail();
    const response = await post(bounceBody({ Metadata: { 'outbox-id': email.id } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    const [bounced] = (await listEmails(handle.db)).emails;
    expect(bounced).toMatchObject({ status: 'bounced', bounceType: 'HardBounce' });
    expect(await findSuppression(handle.db, 'asha@example.in')).toMatchObject({
      reason: 'hard_bounce',
      source: 'postmark',
    });
    const logged = logs.join('');
    expect(logged).toContain('postmark.received');
    expect(logged).toContain(email.id);
    expect(logged).not.toContain('asha@example.in');
    expect(logged).not.toContain('user unknown');
  });

  it('acknowledges a repeated event and a record it does not handle', async () => {
    expect((await post(bounceBody())).status).toBe(200);
    expect((await post(bounceBody())).status).toBe(200);
    const delivery = await post(JSON.stringify({ RecordType: 'Delivery', MessageID: 'm' }));
    expect(delivery.status).toBe(200);
    expect(logs.join('')).toContain('"outcome":"duplicate"');
    expect(logs.join('')).toContain('"outcome":"ignored"');
  });

  it('refuses a body it cannot read, and one that is too large', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post(bounceBody({ Email: 'nobody' }))).status).toBe(400);
    expect((await post(bounceBody({ Details: 'x'.repeat(70 * 1024) }))).status).toBe(413);
  });
});
