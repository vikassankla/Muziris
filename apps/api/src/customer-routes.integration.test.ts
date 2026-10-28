import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
import {
  createBuyerUser,
  createCustomer,
  createCustomerGroup,
  createInvitation,
} from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://admin.example.com';
const MISSING = '00000000-0000-4000-8000-000000000000';

const ADDRESS = {
  label: 'Pune plant',
  countryCode: 'IN',
  line1: 'Plot 12, MIDC Bhosari',
  city: 'Pune',
  regionCode: '27',
  postalCode: '411 026',
  gstin: '27aapfu0939f1zv',
} as const;

describe.skipIf(!url)('customer routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_customers');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate customer_address, customer_invitation, customer_buyer_user, customer_customer,
        customer_group, access_admin_user_role, access_admin_role_permission, access_admin_role,
        identity_session, identity_user, identity_rate_limit cascade`,
    );
    logs = [];
  });

  afterAll(async () => {
    await handle.close();
  });

  function app() {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    return createApp({
      logger: createLogger('info', stream),
      db: handle.db,
      pingDatabase: () => Promise.resolve(),
      corsOrigins: [ORIGIN],
      maxBodyBytes: 64 * 1024,
      now: () => new Date('2026-11-04T09:00:00.000Z'),
      clientIp: () => '203.0.113.7',
    });
  }

  /** Creates an admin holding exactly these permissions and signs them in. */
  async function signedInAdmin(email: string, permissions: AdminPermission[]): Promise<string> {
    const user = await createUser(handle.db, {
      realm: 'admin',
      email,
      displayName: email,
      password: PASSWORD,
    });
    const role = await createAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, {
      code: `role_${email.split('@')[0] ?? 'x'}`,
      name: email,
      permissions,
    });
    await assignAdminRole(handle.db, SYSTEM_ADMIN_ACCESS, user.id, role.id);
    const res = await app().request('/admin/v1/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  function call(method: string, path: string, cookie: string, body?: unknown) {
    return app().request(`/admin/v1/customers${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  /**
   * Acme with one subsidiary (Acme West), a customer group, a buyer user and an open
   * invitation. `fill` puts their ids into a path or body.
   */
  async function seed() {
    const group = await createCustomerGroup(handle.db, { code: 'distributors', name: 'Dist' });
    const acme = await createCustomer(handle.db, { name: 'Acme' });
    const west = await createCustomer(handle.db, { name: 'Acme West', parentId: acme.id });
    await createBuyerUser(handle.db, {
      customerId: acme.id,
      email: 'priya@acme.example',
      displayName: 'Priya',
    });
    // An existing buyer account that is not yet a buyer user of any customer.
    await createUser(handle.db, {
      realm: 'buyer',
      email: 'kiran@acme.example',
      displayName: 'Kiran',
    });
    const inviter = await createUser(handle.db, {
      realm: 'admin',
      email: 'inviter@org.example',
      displayName: 'Inviter',
    });
    const { invitation } = await createInvitation(handle.db, {
      customerId: acme.id,
      email: 'old@acme.example',
      displayName: 'Old',
      invitedByUserId: inviter.id,
      now: new Date('2026-11-01T00:00:00.000Z'),
    });
    const invitationId = invitation.id;
    const fill = (s: string) =>
      s
        .replaceAll('{acme}', acme.id)
        .replaceAll('{west}', west.id)
        .replaceAll('{group}', group.id)
        .replaceAll('{invitation}', invitationId);
    const fillBody = (body: unknown): unknown =>
      body === undefined ? undefined : JSON.parse(fill(JSON.stringify(body)));
    return { group, acme, west, invitationId, fill, fillBody };
  }

  it.each([
    ['GET', '/groups', undefined, 'customer.view', 200],
    ['POST', '/groups', { code: 'contractors', name: 'Contractors' }, 'customer.manage', 201],
    ['GET', '', undefined, 'customer.view', 200],
    ['GET', '?topLevel=true&limit=10', undefined, 'customer.view', 200],
    ['POST', '', { name: 'Globex' }, 'customer.manage', 201],
    ['GET', '/{acme}', undefined, 'customer.view', 200],
    ['GET', '/{acme}/subsidiaries', undefined, 'customer.view', 200],
    ['PUT', '/{west}/parent', { parentId: null }, 'customer.manage', 200],
    ['PUT', '/{acme}/group', { groupId: '{group}' }, 'customer.manage', 200],
    ['GET', '/{acme}/buyer-users', undefined, 'customer.view', 200],
    [
      'POST',
      '/{acme}/buyer-users',
      { email: 'ravi@acme.example', displayName: 'Ravi' },
      'customer.manage',
      201,
    ],
    ['POST', '/{acme}/buyer-users/link', { email: 'kiran@acme.example' }, 'customer.manage', 201],
    ['GET', '/{acme}/invitations', undefined, 'customer.view', 200],
    [
      'POST',
      '/{acme}/invitations',
      { email: 'meera@acme.example', displayName: 'Meera' },
      'customer.manage',
      201,
    ],
    ['POST', '/invitations/{invitation}/revoke', undefined, 'customer.manage', 200],
    ['GET', '/{acme}/addresses', undefined, 'customer.view', 200],
    ['POST', '/{acme}/addresses', ADDRESS, 'customer.manage', 201],
  ] as const)(
    '%s %s with body %j answers 401 signed out, 403 without %s, and %i with it',
    async (method, rawPath, rawBody, permission, status) => {
      const { fill, fillBody } = await seed();
      const path = fill(rawPath);
      const body = fillBody(rawBody);

      const signedOut = await call(method, path, '', body);
      expect(signedOut.status).toBe(401);
      expect(await signedOut.json()).toMatchObject({ code: 'not_signed_in' });

      const other: AdminPermission =
        permission === 'customer.view' ? 'customer.manage' : 'customer.view';
      const without = await signedInAdmin('meera@org.example', [other]);
      const denied = await call(method, path, without, body);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      expect(await denied.json()).toMatchObject({ code: 'permission_denied' });

      const withIt = await signedInAdmin('asha@org.example', [permission]);
      const allowed = await call(method, path, withIt, body);
      expect(allowed.status).toBe(status);
      expect(allowed.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('lets a customer manager build a customer hierarchy end to end', async () => {
    const asha = await signedInAdmin('asha@org.example', ['customer.view', 'customer.manage']);

    const group = await json<{ customerGroup: { id: string } }>(
      await call('POST', '/groups', asha, { code: 'distributors', name: 'Distributors' }),
    );
    const acme = await json<{ customer: { id: string } }>(
      await call('POST', '', asha, { name: 'Acme', groupId: group.customerGroup.id }),
    );
    const acmeId = acme.customer.id;
    const west = await json<{ customer: { id: string } }>(
      await call('POST', '', asha, { name: 'Acme West', parentId: acmeId }),
    );
    const pune = await json<{ customer: { id: string } }>(
      await call('POST', '', asha, { name: 'Acme Pune' }),
    );
    expect(logs.some((l) => l.includes('customers.customer_created'))).toBe(true);

    const moved = await call('PUT', `/${pune.customer.id}/parent`, asha, {
      parentId: west.customer.id,
    });
    expect(await json(moved)).toMatchObject({ customer: { parentId: west.customer.id } });

    const cycle = await call('PUT', `/${acmeId}/parent`, asha, { parentId: pune.customer.id });
    expect(cycle.status).toBe(409);
    expect(await cycle.json()).toMatchObject({ code: 'hierarchy_cycle' });

    expect(await json(await call('GET', `/${acmeId}/subsidiaries`, asha))).toMatchObject({
      customers: [{ name: 'Acme West' }],
      nextAfter: null,
    });
    expect(await json(await call('GET', '?topLevel=true', asha))).toMatchObject({
      customers: [{ name: 'Acme' }],
    });
    expect(await json(await call('GET', `?groupId=${group.customerGroup.id}`, asha))).toMatchObject(
      { customers: [{ id: acmeId }] },
    );

    // Every customer, one at a time, by name.
    const names: string[] = [];
    let after = '';
    for (;;) {
      const page = await json<{ customers: { name: string }[]; nextAfter: string | null }>(
        await call('GET', `?limit=1${after ? `&after=${after}` : ''}`, asha),
      );
      names.push(...page.customers.map((c) => c.name));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(names).toEqual(['Acme', 'Acme Pune', 'Acme West']);

    const ungrouped = await call('PUT', `/${acmeId}/group`, asha, { groupId: null });
    expect(await json(ungrouped)).toMatchObject({ customer: { groupId: null } });
  });

  it('lets a customer manager add buyer users, invitations and addresses', async () => {
    const asha = await signedInAdmin('asha@org.example', ['customer.view', 'customer.manage']);
    const { acme } = await seed();

    const created = await call('POST', `/${acme.id}/buyer-users`, asha, {
      email: 'ravi@acme.example',
      displayName: 'Ravi',
      password: 'a long and quiet passphrase',
    });
    expect(created.status).toBe(201);
    const { buyerUser } = await json<{ buyerUser: { userId: string } }>(created);
    expect(
      await json(
        await call('GET', `/${acme.id}/buyer-users?limit=1&after=${buyerUser.userId}`, asha),
      ),
    ).toEqual({ buyerUsers: [], nextAfter: null });
    const buyers = await json<{ buyerUsers: { userId: string }[] }>(
      await call('GET', `/${acme.id}/buyer-users`, asha),
    );
    expect(buyers.buyerUsers.map((b) => b.userId)).toContain(buyerUser.userId);

    const invited = await call('POST', `/${acme.id}/invitations`, asha, {
      email: 'Meera@Acme.example',
      displayName: 'Meera',
      expiresInHours: 48,
    });
    expect(invited.status).toBe(201);
    const { invitation, token } = await json<{
      invitation: { id: string; email: string; expiresAt: string };
      token: string;
    }>(invited);
    expect(invitation).toMatchObject({
      email: 'meera@acme.example',
      expiresAt: '2026-11-06T09:00:00.000Z',
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = await json<{ invitations: { id: string }[] }>(
      await call('GET', `/${acme.id}/invitations`, asha),
    );
    expect(pending.invitations.map((i) => i.id)).toContain(invitation.id);

    const revoked = await call('POST', `/invitations/${invitation.id}/revoke`, asha);
    expect(await json(revoked)).toMatchObject({
      invitation: { revokedAt: '2026-11-04T09:00:00.000Z' },
    });
    const again = await call('POST', `/invitations/${invitation.id}/revoke`, asha);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'invitation_closed' });

    const added = await call('POST', `/${acme.id}/addresses`, asha, {
      ...ADDRESS,
      isDefaultBilling: true,
    });
    expect(added.status).toBe(201);
    expect(await json(added)).toMatchObject({
      address: { customerId: acme.id, postalCode: '411026', gstin: '27AAPFU0939F1ZV' },
    });
    const usAddress = await call('POST', `/${acme.id}/addresses`, asha, {
      label: 'Head office',
      countryCode: 'US',
      line1: '1 Market St',
      city: 'San Francisco',
      regionCode: 'ca',
      postalCode: '94105',
      // A customer id in the body is ignored; the path decides.
      customerId: MISSING,
    });
    expect(await json(usAddress)).toMatchObject({ address: { customerId: acme.id } });
    const list = await json<{ addresses: { label: string }[]; nextAfter: string | null }>(
      await call('GET', `/${acme.id}/addresses?limit=1`, asha),
    );
    expect(list.addresses.map((a) => a.label)).toEqual(['Pune plant']);
    expect(list.nextAfter).not.toBeNull();

    // Audit lines say who did what to which record, never the emails, tokens or passwords.
    const audit = logs.filter((l) => l.includes('"msg":"customers.'));
    expect(audit.length).toBeGreaterThanOrEqual(5);
    for (const line of audit) {
      expect(line).not.toMatch(/@acme\.example|passphrase|Acme/i);
      expect(line).not.toContain(token);
    }
  });

  it.each([
    [
      'a group code with spaces',
      'POST',
      '/groups',
      { code: 'Big Ones', name: 'X' },
      400,
      'validation_failed',
    ],
    [
      'a taken group code',
      'POST',
      '/groups',
      { code: 'distributors', name: 'X' },
      409,
      'customer_group_code_taken',
    ],
    ['a customer with no name', 'POST', '', { name: '  ' }, 400, 'validation_failed'],
    [
      'a customer under a missing parent',
      'POST',
      '',
      { name: 'X', parentId: MISSING },
      404,
      'customer_not_found',
    ],
    [
      'a customer in a missing group',
      'POST',
      '',
      { name: 'X', groupId: MISSING },
      404,
      'customer_group_not_found',
    ],
    ['a malformed customer id', 'GET', "/1' or '1'='1", undefined, 400, 'validation_failed'],
    ['a missing customer', 'GET', `/${MISSING}`, undefined, 404, 'customer_not_found'],
    [
      'subsidiaries of a missing customer',
      'GET',
      `/${MISSING}/subsidiaries`,
      undefined,
      404,
      'customer_not_found',
    ],
    [
      'buyer users of a missing customer',
      'GET',
      `/${MISSING}/buyer-users`,
      undefined,
      404,
      'customer_not_found',
    ],
    [
      'invitations of a missing customer',
      'GET',
      `/${MISSING}/invitations`,
      undefined,
      404,
      'customer_not_found',
    ],
    [
      'addresses of a missing customer',
      'GET',
      `/${MISSING}/addresses`,
      undefined,
      404,
      'customer_not_found',
    ],
    ['a page size of 0', 'GET', '?limit=0', undefined, 400, 'validation_failed'],
    ['a page size over 200', 'GET', '/groups?limit=201', undefined, 400, 'validation_failed'],
    [
      'a malformed page cursor',
      'GET',
      '/{acme}/addresses?after=last',
      undefined,
      400,
      'validation_failed',
    ],
    [
      'top-level and a parent together',
      'GET',
      '?topLevel=true&parentId={acme}',
      undefined,
      400,
      'validation_failed',
    ],
    [
      'a customer moved under its subsidiary',
      'PUT',
      '/{acme}/parent',
      { parentId: '{west}' },
      409,
      'hierarchy_cycle',
    ],
    [
      'a customer moved under itself',
      'PUT',
      '/{acme}/parent',
      { parentId: '{acme}' },
      409,
      'hierarchy_cycle',
    ],
    [
      'moving a missing customer',
      'PUT',
      `/${MISSING}/parent`,
      { parentId: null },
      404,
      'customer_not_found',
    ],
    [
      'a missing group',
      'PUT',
      '/{acme}/group',
      { groupId: MISSING },
      404,
      'customer_group_not_found',
    ],
    ['a group change with no body', 'PUT', '/{acme}/group', undefined, 400, 'validation_failed'],
    [
      'a buyer user with a bad email',
      'POST',
      '/{acme}/buyer-users',
      { email: 'not-an-email', displayName: 'X' },
      400,
      'validation_failed',
    ],
    [
      'a buyer user whose email is taken',
      'POST',
      '/{acme}/buyer-users',
      { email: 'priya@acme.example', displayName: 'X' },
      409,
      'email_taken',
    ],
    [
      'a buyer user with a weak password',
      'POST',
      '/{acme}/buyer-users',
      { email: 'new@acme.example', displayName: 'X', password: 'short' },
      400,
      'password_policy',
    ],
    [
      'a buyer user for a missing customer',
      'POST',
      `/${MISSING}/buyer-users`,
      { email: 'new@acme.example', displayName: 'X' },
      404,
      'customer_not_found',
    ],
    [
      'linking an email with no buyer account',
      'POST',
      '/{acme}/buyer-users/link',
      { email: 'nobody@acme.example' },
      422,
      'not_a_buyer',
    ],
    [
      'linking an admin account',
      'POST',
      '/{acme}/buyer-users/link',
      { email: 'inviter@org.example' },
      422,
      'not_a_buyer',
    ],
    [
      'linking a buyer user twice',
      'POST',
      '/{acme}/buyer-users/link',
      { email: 'priya@acme.example' },
      409,
      'buyer_user_exists',
    ],
    [
      'an invitation for a missing customer',
      'POST',
      `/${MISSING}/invitations`,
      { email: 'x@acme.example', displayName: 'X' },
      404,
      'customer_not_found',
    ],
    [
      'an invitation open for too long',
      'POST',
      '/{acme}/invitations',
      { email: 'x@acme.example', displayName: 'X', expiresInHours: 721 },
      400,
      'validation_failed',
    ],
    [
      'an invitation with a bad email',
      'POST',
      '/{acme}/invitations',
      { email: 'x', displayName: 'X' },
      400,
      'validation_failed',
    ],
    [
      'revoking a missing invitation',
      'POST',
      `/invitations/${MISSING}/revoke`,
      undefined,
      404,
      'invitation_not_found',
    ],
    [
      'an address with a bad PIN code',
      'POST',
      '/{acme}/addresses',
      { ...ADDRESS, postalCode: '011026' },
      400,
      'validation_failed',
    ],
    [
      'an address whose GSTIN is for another state',
      'POST',
      '/{acme}/addresses',
      { ...ADDRESS, regionCode: '29' },
      400,
      'validation_failed',
    ],
    [
      'an address in another country',
      'POST',
      '/{acme}/addresses',
      { ...ADDRESS, countryCode: 'GB' },
      400,
      'validation_failed',
    ],
    [
      'an address for a missing customer',
      'POST',
      `/${MISSING}/addresses`,
      ADDRESS,
      404,
      'customer_not_found',
    ],
  ] as const)('refuses %s', async (_label, method, rawPath, rawBody, status, code) => {
    const asha = await signedInAdmin('asha@org.example', ['customer.view', 'customer.manage']);
    const { fill, fillBody } = await seed();
    const res = await call(method, fill(rawPath), asha, fillBody(rawBody));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });

  it.each([
    ['POST', '', { name: 'Evil' }],
    ['PUT', '/{acme}/parent', { parentId: null }],
    ['POST', '/{acme}/invitations', { email: 'evil@evil.example', displayName: 'Evil' }],
    ['POST', '/invitations/{invitation}/revoke', undefined],
  ] as const)('refuses %s %s from an untrusted origin', async (method, rawPath, rawBody) => {
    const asha = await signedInAdmin('asha@org.example', ['customer.view', 'customer.manage']);
    const { fill, fillBody } = await seed();
    const body = fillBody(rawBody);
    const res = await app().request(`/admin/v1/customers${fill(rawPath)}`, {
      method,
      headers: {
        Cookie: asha,
        Origin: 'https://evil.example.net',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'untrusted_origin' });
  });
});
