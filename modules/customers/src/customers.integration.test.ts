import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser, EmailTakenError, signIn } from '@muziris/identity';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addAddress,
  createBuyerUser,
  createCustomer,
  createCustomerGroup,
  createInvitation,
  CustomerError,
  descendantCustomerIds,
  findBuyerUser,
  findCustomerForBuyer,
  findPendingInvitation,
  INVITATION_DEFAULT_TTL_MS,
  linkBuyerUser,
  listAddresses,
  listAddressesForBuyer,
  listBuyerUsersForBuyer,
  listCustomerGroups,
  listCustomers,
  listCustomersForBuyer,
  listBuyerUsers,
  listPendingInvitations,
  listSubsidiaries,
  revokeInvitation,
  setCustomerGroup,
  setCustomerParent,
  type Customer,
  type CustomerErrorCode,
  type CustomerReach,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];

const PASSWORD = 'quiet lantern over the harbour';
const NOW = new Date('2026-11-04T10:00:00.000Z');
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

async function expectRefused(promise: Promise<unknown>, code: CustomerErrorCode) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CustomerError);
  expect((error as CustomerError).code).toBe(code);
}

describe.skipIf(!url)('customers module against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'customers');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate customer_address, customer_invitation, customer_buyer_user, customer_customer,
        customer_group, identity_session, identity_user cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  /**
   * Acme
   * ├── Acme East
   * └── Acme West
   *     └── Acme Pune
   *         └── Acme Pune Plant 2
   * Globex
   */
  async function seedHierarchy() {
    const db = handle.db;
    const acme = await createCustomer(db, { name: 'Acme' });
    const east = await createCustomer(db, { name: 'Acme East', parentId: acme.id });
    const west = await createCustomer(db, { name: 'Acme West', parentId: acme.id });
    const pune = await createCustomer(db, { name: 'Acme Pune', parentId: west.id });
    const plant2 = await createCustomer(db, { name: 'Acme Pune Plant 2', parentId: pune.id });
    const globex = await createCustomer(db, { name: 'Globex' });
    return { acme, east, west, pune, plant2, globex };
  }

  type Tree = Awaited<ReturnType<typeof seedHierarchy>>;
  type Name = keyof Tree;

  async function descendantNames(tree: Tree, of: Name): Promise<Name[]> {
    const rows = await handle.db.execute<{ id: string }>(descendantCustomerIds(tree[of].id));
    const byId = new Map(Object.entries(tree).map(([name, c]) => [c.id, name as Name]));
    return rows.map((r) => byId.get(r.id) ?? 'unknown').sort() as Name[];
  }

  const namesOf = (tree: Tree, rows: { id: string }[] | Customer[]) => {
    const byId = new Map(Object.entries(tree).map(([name, c]) => [c.id, name]));
    return rows.map((r) => byId.get(r.id)).sort();
  };

  describe('customer groups', () => {
    it('creates, lists and assigns groups', async () => {
      const distributors = await createCustomerGroup(handle.db, {
        code: 'distributors',
        name: 'Distributors',
      });
      await createCustomerGroup(handle.db, { code: 'contractors', name: 'Contractors' });
      expect((await listCustomerGroups(handle.db)).customerGroups.map((g) => g.code)).toEqual([
        'contractors',
        'distributors',
      ]);

      const acme = await createCustomer(handle.db, { name: 'Acme', groupId: distributors.id });
      expect(acme.groupId).toBe(distributors.id);
      expect((await setCustomerGroup(handle.db, acme.id, null)).groupId).toBeNull();
    });

    it('refuses a taken code and unknown groups or customers', async () => {
      await createCustomerGroup(handle.db, { code: 'distributors', name: 'Distributors' });
      await expectRefused(
        createCustomerGroup(handle.db, { code: 'distributors', name: 'Again' }),
        'customer_group_code_taken',
      );
      await expectRefused(
        createCustomer(handle.db, { name: 'Acme', groupId: MISSING_ID }),
        'customer_group_not_found',
      );
      await expectRefused(
        createCustomer(handle.db, { name: 'Acme', parentId: MISSING_ID }),
        'customer_not_found',
      );
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      await expectRefused(
        setCustomerGroup(handle.db, acme.id, MISSING_ID),
        'customer_group_not_found',
      );
      await expectRefused(setCustomerGroup(handle.db, MISSING_ID, null), 'customer_not_found');
    });
  });

  describe('hierarchy', () => {
    it.each<[Name, Name[]]>([
      ['acme', ['east', 'plant2', 'pune', 'west']],
      ['west', ['plant2', 'pune']],
      ['pune', ['plant2']],
      ['plant2', []],
      ['east', []],
      ['globex', []],
    ])('descendants of %s are %j', async (of, expected) => {
      const tree = await seedHierarchy();
      expect(await descendantNames(tree, of)).toEqual(expected);
    });

    it('lists direct subsidiaries only', async () => {
      const tree = await seedHierarchy();
      expect((await listSubsidiaries(handle.db, tree.acme.id)).map((c) => c.name)).toEqual([
        'Acme East',
        'Acme West',
      ]);
    });

    it.each<[Name, Name]>([
      ['acme', 'acme'],
      ['acme', 'east'],
      ['acme', 'plant2'],
      ['west', 'pune'],
      ['west', 'plant2'],
      ['pune', 'plant2'],
    ])('refuses to move %s under %s, which would form a cycle', async (move, under) => {
      const tree = await seedHierarchy();
      await expectRefused(
        setCustomerParent(handle.db, tree[move].id, tree[under].id),
        'hierarchy_cycle',
      );
      expect(await descendantNames(tree, 'acme')).toEqual(['east', 'plant2', 'pune', 'west']);
    });

    it.each<[Name, Name | null, Name, Name[]]>([
      ['east', 'west', 'west', ['east', 'plant2', 'pune']],
      ['pune', 'east', 'east', ['plant2', 'pune']],
      ['pune', null, 'acme', ['east', 'west']],
      ['globex', 'plant2', 'west', ['globex', 'plant2', 'pune']],
      ['plant2', 'acme', 'acme', ['east', 'plant2', 'pune', 'west']],
    ])('moves %s under %s; then %s has %j below it', async (move, under, check, expected) => {
      const tree = await seedHierarchy();
      const moved = await setCustomerParent(
        handle.db,
        tree[move].id,
        under === null ? null : tree[under].id,
      );
      expect(moved.parentId).toBe(under === null ? null : tree[under].id);
      expect(await descendantNames(tree, check)).toEqual(expected);
    });

    it('refuses unknown customers and parents', async () => {
      const tree = await seedHierarchy();
      await expectRefused(setCustomerParent(handle.db, MISSING_ID, null), 'customer_not_found');
      await expectRefused(
        setCustomerParent(handle.db, tree.east.id, MISSING_ID),
        'customer_not_found',
      );
    });

    it('lets only one of two crossing moves through when they run at the same time', async () => {
      const a = await createCustomer(handle.db, { name: 'A' });
      const b = await createCustomer(handle.db, { name: 'B' });
      const results = await Promise.allSettled([
        setCustomerParent(handle.db, a.id, b.id),
        setCustomerParent(handle.db, b.id, a.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected');
      expect((refused?.reason as CustomerError).code).toBe('hierarchy_cycle');
    });

    it('refuses a customer as its own parent in the database too', async () => {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      await expect(
        handle.db.execute(sql`update customer_customer set parent_id = id where id = ${acme.id}`),
      ).rejects.toThrow();
    });

    it('still ends the descendant walk if a cycle were written around the module', async () => {
      const a = await createCustomer(handle.db, { name: 'A' });
      const b = await createCustomer(handle.db, { name: 'B', parentId: a.id });
      await handle.db.execute(
        sql`update customer_customer set parent_id = ${b.id} where id = ${a.id}`,
      );
      const rows = await handle.db.execute<{ id: string }>(descendantCustomerIds(a.id));
      expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('plugs into another query as an id list, the way @muziris/access uses it', async () => {
      const tree = await seedHierarchy();
      const rows = await handle.db.execute<{ name: string }>(
        sql`select name from customer_customer
            where id = ${tree.west.id} or id in (${descendantCustomerIds(tree.west.id)})
            order by name`,
      );
      expect(rows.map((r) => r.name)).toEqual(['Acme Pune', 'Acme Pune Plant 2', 'Acme West']);
    });
  });

  describe('buyer users', () => {
    it('creates a buyer account and links it to a customer', async () => {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      const buyer = await createBuyerUser(handle.db, {
        customerId: acme.id,
        email: 'priya@acme.example',
        displayName: 'Priya',
        password: PASSWORD,
      });
      expect(await findBuyerUser(handle.db, buyer.userId)).toMatchObject({
        userId: buyer.userId,
        customerId: acme.id,
      });
      const signedIn = await signIn(handle.db, {
        realm: 'buyer',
        email: 'priya@acme.example',
        password: PASSWORD,
        now: NOW,
      });
      expect(signedIn.ok && signedIn.user.id).toBe(buyer.userId);
    });

    it('links an existing buyer account by email, once', async () => {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      const globex = await createCustomer(handle.db, { name: 'Globex' });
      const user = await createUser(handle.db, {
        realm: 'buyer',
        email: 'ravi@acme.example',
        displayName: 'Ravi',
      });
      const buyer = await linkBuyerUser(handle.db, acme.id, 'Ravi@Acme.example');
      expect(buyer.userId).toBe(user.id);
      await expectRefused(
        linkBuyerUser(handle.db, globex.id, 'ravi@acme.example'),
        'buyer_user_exists',
      );
    });

    it('refuses admin accounts, unknown emails and unknown customers', async () => {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      await createUser(handle.db, { realm: 'admin', email: 'asha@org.example', displayName: 'A' });
      await expectRefused(linkBuyerUser(handle.db, acme.id, 'asha@org.example'), 'not_a_buyer');
      await expectRefused(linkBuyerUser(handle.db, acme.id, 'nobody@acme.example'), 'not_a_buyer');
      await expectRefused(
        createBuyerUser(handle.db, {
          customerId: MISSING_ID,
          email: 'orphan@acme.example',
          displayName: 'Orphan',
        }),
        'customer_not_found',
      );
      // The customer was checked before identity was touched.
      expect(
        await signIn(handle.db, {
          realm: 'buyer',
          email: 'orphan@acme.example',
          password: PASSWORD,
          now: NOW,
        }),
      ).toMatchObject({ ok: false, reason: 'unknown_email' });
    });

    it('returns nothing for an identity user who is not a buyer user', async () => {
      expect(await findBuyerUser(handle.db, MISSING_ID)).toBeUndefined();
    });
  });

  describe('invitations', () => {
    async function invite(email = 'meera@acme.example', now = NOW) {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      const admin = await createUser(handle.db, {
        realm: 'admin',
        email: 'asha@org.example',
        displayName: 'Asha',
      });
      const created = await createInvitation(handle.db, {
        customerId: acme.id,
        email,
        displayName: 'Meera',
        invitedByUserId: admin.id,
        now,
      });
      return { acme, ...created };
    }

    it('stores only a hash of the token and expires after seven days', async () => {
      const { token, invitation } = await invite();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(invitation.expiresAt.getTime() - NOW.getTime()).toBe(INVITATION_DEFAULT_TTL_MS);
      const rows = await handle.db.execute<{ token_hash: string }>(
        sql`select token_hash from customer_invitation`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.token_hash).not.toContain(token);
      expect(invitation).not.toHaveProperty('tokenHash');
    });

    it('turns an accepted invitation into a buyer user who can sign in, once', async () => {
      const { acme, token } = await invite();
      expect((await findPendingInvitation(handle.db, token, NOW)).email).toBe('meera@acme.example');

      const later = new Date(NOW.getTime() + 60_000);
      const buyer = await acceptInvitation(handle.db, { token, password: PASSWORD, now: later });
      expect(buyer.customerId).toBe(acme.id);
      expect(
        await signIn(handle.db, {
          realm: 'buyer',
          email: 'meera@acme.example',
          password: PASSWORD,
          now: later,
        }),
      ).toMatchObject({ ok: true, user: { id: buyer.userId, displayName: 'Meera' } });

      await expectRefused(
        acceptInvitation(handle.db, { token, password: PASSWORD, now: later }),
        'invitation_closed',
      );
      expect((await listPendingInvitations(handle.db, acme.id, later)).invitations).toEqual([]);
    });

    it.each([
      ['1 ms before expiry', INVITATION_DEFAULT_TTL_MS - 1, null],
      ['exactly at expiry', INVITATION_DEFAULT_TTL_MS, 'invitation_expired'],
      ['1 ms after expiry', INVITATION_DEFAULT_TTL_MS + 1, 'invitation_expired'],
    ] as const)('accepting %s', async (_label, offsetMs, refusal) => {
      const { acme, token } = await invite();
      const now = new Date(NOW.getTime() + offsetMs);
      const { invitations: pending } = await listPendingInvitations(handle.db, acme.id, now);
      const accepting = acceptInvitation(handle.db, { token, password: PASSWORD, now });
      if (refusal === null) {
        expect(pending).toHaveLength(1);
        expect((await accepting).customerId).toBe(acme.id);
      } else {
        expect(pending).toHaveLength(0);
        await expectRefused(accepting, refusal);
        await expectRefused(findPendingInvitation(handle.db, token, now), refusal);
      }
    });

    it.each(['', 'not-a-token', 'A'.repeat(43), `${'A'.repeat(42)}!`])(
      'refuses the token %j',
      async (token) => {
        await invite();
        await expectRefused(
          acceptInvitation(handle.db, { token, password: PASSWORD, now: NOW }),
          'invitation_not_found',
        );
      },
    );

    it('revokes the older invitation when the same person is invited again', async () => {
      const first = await invite();
      const second = await createInvitation(handle.db, {
        customerId: first.acme.id,
        email: 'meera@acme.example',
        displayName: 'Meera',
        invitedByUserId: first.invitation.invitedByUserId,
        now: NOW,
      });
      await expectRefused(findPendingInvitation(handle.db, first.token, NOW), 'invitation_closed');
      const { invitations: pending } = await listPendingInvitations(handle.db, first.acme.id, NOW);
      expect(pending.map((i) => i.id)).toEqual([second.invitation.id]);
    });

    it('revokes an open invitation and refuses to revoke it twice', async () => {
      const { invitation, token } = await invite();
      expect((await revokeInvitation(handle.db, invitation.id, NOW)).revokedAt).toEqual(NOW);
      await expectRefused(revokeInvitation(handle.db, invitation.id, NOW), 'invitation_closed');
      await expectRefused(revokeInvitation(handle.db, MISSING_ID, NOW), 'invitation_not_found');
      await expectRefused(
        acceptInvitation(handle.db, { token, password: PASSWORD, now: NOW }),
        'invitation_closed',
      );
    });

    it('leaves the invitation open when the email already has a buyer account', async () => {
      const { acme, token } = await invite();
      await createUser(handle.db, {
        realm: 'buyer',
        email: 'meera@acme.example',
        displayName: 'Meera elsewhere',
      });
      await expect(
        acceptInvitation(handle.db, { token, password: PASSWORD, now: NOW }),
      ).rejects.toBeInstanceOf(EmailTakenError);
      expect((await listPendingInvitations(handle.db, acme.id, NOW)).invitations).toHaveLength(1);
    });

    it('refuses invitations to unknown customers', async () => {
      await expectRefused(
        createInvitation(handle.db, {
          customerId: MISSING_ID,
          email: 'meera@acme.example',
          displayName: 'Meera',
          invitedByUserId: MISSING_ID,
          now: NOW,
        }),
        'customer_not_found',
      );
    });
  });

  describe('addresses', () => {
    const pune = {
      label: 'Pune plant',
      countryCode: 'IN',
      line1: 'Plot 12, MIDC Bhosari',
      city: 'Pune',
      regionCode: '27',
      postalCode: '411026',
      gstin: '27AAPFU0939F1ZV',
    } as const;
    const sanFrancisco = {
      label: 'Head office',
      countryCode: 'US',
      line1: '1 Market St',
      city: 'San Francisco',
      regionCode: 'CA',
      postalCode: '94105',
    } as const;

    it('keeps one default billing and one default shipping address per customer', async () => {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      const first = await addAddress(handle.db, {
        ...pune,
        customerId: acme.id,
        isDefaultBilling: true,
        isDefaultShipping: true,
      });
      const second = await addAddress(handle.db, {
        ...sanFrancisco,
        customerId: acme.id,
        isDefaultBilling: true,
      });
      const { addresses: list } = await listAddresses(handle.db, acme.id);
      expect(list.map((a) => [a.id, a.isDefaultBilling, a.isDefaultShipping])).toEqual([
        [second.id, true, false],
        [first.id, false, true],
      ]);
    });

    it('refuses an address for an unknown customer', async () => {
      await expectRefused(
        addAddress(handle.db, { ...pune, customerId: MISSING_ID }),
        'customer_not_found',
      );
    });

    it.each([
      ['a PIN code starting with 0', `'IN', '27', '011026', null`],
      ['a five-digit Indian postal code', `'IN', '27', '41102', null`],
      ['a state name for India', `'IN', 'MH', '411026', null`],
      ['a GSTIN from another state', `'IN', '29', '560001', '27AAPFU0939F1ZV'`],
      ['a lower-case GSTIN', `'IN', '27', '411026', '27aapfu0939f1zv'`],
      ['a GSTIN on a US address', `'US', 'CA', '94105', '27AAPFU0939F1ZV'`],
      ['a ZIP+4 without the hyphen', `'US', 'CA', '941051234', null`],
      ['a lower-case US state', `'US', 'ca', '94105', null`],
      ['another country', `'GB', 'LN', 'SW1A1AA', null`],
    ])('refuses %s in the database too', async (_label, values) => {
      const acme = await createCustomer(handle.db, { name: 'Acme' });
      await expect(
        handle.db.execute(
          sql`insert into customer_address (customer_id, label, line1, city, country_code, region_code, postal_code, gstin)
              values (${acme.id}, 'x', 'x', 'x', ${sql.raw(values)})`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('admin lists, a page at a time', () => {
    /** Follows nextAfter until the last page, collecting each page's ids. */
    async function walk(
      fetch: (after: string | undefined) => Promise<{ ids: string[]; nextAfter: string | null }>,
    ): Promise<string[][]> {
      const pages: string[][] = [];
      let after: string | undefined;
      for (;;) {
        const page = await fetch(after);
        pages.push(page.ids);
        if (page.nextAfter === null) return pages;
        after = page.nextAfter;
      }
    }

    it('pages customers by name, with hierarchy and group filters', async () => {
      const tree = await seedHierarchy();
      const pages = await walk(async (after) => {
        const page = await listCustomers(handle.db, { limit: 2, ...(after ? { after } : {}) });
        return { ids: page.customers.map((c) => c.id), nextAfter: page.nextAfter };
      });
      const byId = new Map(Object.entries(tree).map(([name, c]) => [c.id, name]));
      expect(pages.map((ids) => ids.map((id) => byId.get(id)))).toEqual([
        ['acme', 'east'],
        ['pune', 'plant2'],
        ['west', 'globex'],
      ]);

      const names = async (query: Parameters<typeof listCustomers>[1]) =>
        (await listCustomers(handle.db, query)).customers.map((c) => byId.get(c.id));
      expect(await names({ parentId: tree.acme.id })).toEqual(['east', 'west']);
      expect(await names({ topLevel: true })).toEqual(['acme', 'globex']);

      const group = await createCustomerGroup(handle.db, { code: 'plants', name: 'Plants' });
      await setCustomerGroup(handle.db, tree.plant2.id, group.id);
      expect(await names({ groupId: group.id })).toEqual(['plant2']);
      expect(await names({ after: MISSING_ID })).toEqual([]);
    });

    it.each([
      ['a page size of 0', { limit: 0 }],
      ['a page size over 200', { limit: 201 }],
      ['top-level and a parent together', { topLevel: true, parentId: MISSING_ID }],
      ['a malformed after', { after: 'acme' }],
    ])('refuses %s', async (_label, query) => {
      await expect(listCustomers(handle.db, query)).rejects.toThrow();
    });

    it('pages customer groups, buyer users, invitations and addresses', async () => {
      for (const code of ['c_one', 'c_two', 'c_three']) {
        await createCustomerGroup(handle.db, { code, name: code });
      }
      const groups = await walk(async (after) => {
        const page = await listCustomerGroups(handle.db, { limit: 2, ...(after ? { after } : {}) });
        return { ids: page.customerGroups.map((g) => g.code), nextAfter: page.nextAfter };
      });
      expect(groups).toEqual([['c_one', 'c_three'], ['c_two']]);

      const acme = await createCustomer(handle.db, { name: 'Acme' });
      const buyers = [];
      for (const name of ['a', 'b', 'c']) {
        buyers.push(
          await createBuyerUser(handle.db, {
            customerId: acme.id,
            email: `${name}@acme.example`,
            displayName: name,
          }),
        );
      }
      const buyerPages = await walk(async (after) => {
        const page = await listBuyerUsers(handle.db, acme.id, {
          limit: 2,
          ...(after ? { after } : {}),
        });
        return { ids: page.buyerUsers.map((b) => b.userId), nextAfter: page.nextAfter };
      });
      expect(buyerPages.flat().sort()).toEqual(buyers.map((b) => b.userId).sort());
      expect(buyerPages.map((p) => p.length)).toEqual([2, 1]);

      const admin = await createUser(handle.db, {
        realm: 'admin',
        email: 'asha@org.example',
        displayName: 'Asha',
      });
      const sent = [];
      for (const [i, email] of ['x@acme.example', 'y@acme.example'].entries()) {
        const created = await createInvitation(handle.db, {
          customerId: acme.id,
          email,
          displayName: email,
          invitedByUserId: admin.id,
          now: new Date(NOW.getTime() + i),
        });
        sent.push(created.invitation.id);
      }
      const invitationPages = await walk(async (after) => {
        const page = await listPendingInvitations(handle.db, acme.id, NOW, {
          limit: 1,
          ...(after ? { after } : {}),
        });
        return { ids: page.invitations.map((i) => i.id), nextAfter: page.nextAfter };
      });
      expect(invitationPages).toEqual([[sent[0]], [sent[1]]]);

      const address = {
        countryCode: 'US',
        line1: '1 Market St',
        city: 'San Francisco',
        regionCode: 'CA',
        postalCode: '94105',
      } as const;
      const plain = await addAddress(handle.db, { ...address, customerId: acme.id, label: 'A' });
      const shipping = await addAddress(handle.db, {
        ...address,
        customerId: acme.id,
        label: 'Z',
        isDefaultShipping: true,
      });
      const billing = await addAddress(handle.db, {
        ...address,
        customerId: acme.id,
        label: 'M',
        isDefaultBilling: true,
      });
      const addressPages = await walk(async (after) => {
        const page = await listAddresses(handle.db, acme.id, {
          limit: 1,
          ...(after ? { after } : {}),
        });
        return { ids: page.addresses.map((a) => a.id), nextAfter: page.nextAfter };
      });
      expect(addressPages).toEqual([[billing.id], [shipping.id], [plain.id]]);
    });
  });

  describe('buyer scoping', () => {
    async function seedBuyers() {
      const tree = await seedHierarchy();
      const at = async (name: Name, email: string) =>
        createBuyerUser(handle.db, { customerId: tree[name].id, email, displayName: email });
      const buyers = {
        westBuyer: await at('west', 'w@acme.example'),
        puneBuyer: await at('pune', 'p@acme.example'),
        acmeBuyer: await at('acme', 'a@acme.example'),
        globexBuyer: await at('globex', 'g@globex.example'),
      };
      for (const [name, customer] of Object.entries(tree)) {
        await addAddress(handle.db, {
          customerId: customer.id,
          label: name,
          countryCode: 'US',
          line1: '1 Main St',
          city: 'Austin',
          regionCode: 'TX',
          postalCode: '73301',
        });
      }
      return { tree, buyers };
    }

    it.each<[keyof Awaited<ReturnType<typeof seedBuyers>>['buyers'], CustomerReach, Name[]]>([
      ['westBuyer', 'my_customer', ['west']],
      ['westBuyer', 'my_customer_and_subsidiaries', ['plant2', 'pune', 'west']],
      ['puneBuyer', 'my_customer', ['pune']],
      ['puneBuyer', 'my_customer_and_subsidiaries', ['plant2', 'pune']],
      ['acmeBuyer', 'my_customer', ['acme']],
      ['acmeBuyer', 'my_customer_and_subsidiaries', ['acme', 'east', 'plant2', 'pune', 'west']],
      ['globexBuyer', 'my_customer_and_subsidiaries', ['globex']],
    ])('%s with %s sees %j', async (who, reach, expected) => {
      const { tree, buyers } = await seedBuyers();
      const viewer = { buyerUserId: buyers[who].userId, reach };

      expect(namesOf(tree, await listCustomersForBuyer(handle.db, viewer))).toEqual(expected);
      const addresses = await listAddressesForBuyer(handle.db, viewer);
      expect(addresses.map((a) => a.label).sort()).toEqual(expected);

      for (const name of Object.keys(tree) as Name[]) {
        const visible = expected.includes(name);
        const found = await findCustomerForBuyer(handle.db, viewer, tree[name].id);
        expect(found?.id, `${who} finding ${name}`).toBe(visible ? tree[name].id : undefined);
        const theirs = await listAddressesForBuyer(handle.db, viewer, tree[name].id);
        expect(theirs, `${who} listing addresses of ${name}`).toHaveLength(visible ? 1 : 0);
      }
    });

    it('lists the buyer users the viewer may see', async () => {
      const { buyers } = await seedBuyers();
      const seen = await listBuyerUsersForBuyer(handle.db, {
        buyerUserId: buyers.westBuyer.userId,
        reach: 'my_customer_and_subsidiaries',
      });
      expect(seen.map((b) => b.userId).sort()).toEqual(
        [buyers.westBuyer.userId, buyers.puneBuyer.userId].sort(),
      );
    });

    it.each<CustomerReach>(['my_customer', 'my_customer_and_subsidiaries'])(
      'shows nothing to an identity user who is not a buyer user (%s)',
      async (reach) => {
        await seedBuyers();
        const admin = await createUser(handle.db, {
          realm: 'admin',
          email: 'asha@org.example',
          displayName: 'Asha',
        });
        for (const buyerUserId of [admin.id, MISSING_ID]) {
          const viewer = { buyerUserId, reach };
          expect(await listCustomersForBuyer(handle.db, viewer)).toEqual([]);
          expect(await listAddressesForBuyer(handle.db, viewer)).toEqual([]);
          expect(await listBuyerUsersForBuyer(handle.db, viewer)).toEqual([]);
        }
      },
    );

    it('follows a buyer user whose customer moves in the hierarchy', async () => {
      const { tree, buyers } = await seedBuyers();
      const viewer = {
        buyerUserId: buyers.acmeBuyer.userId,
        reach: 'my_customer_and_subsidiaries',
      } as const;
      await setCustomerParent(handle.db, tree.west.id, tree.globex.id);
      expect(namesOf(tree, await listCustomersForBuyer(handle.db, viewer))).toEqual([
        'acme',
        'east',
      ]);
    });
  });
});
