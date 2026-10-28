import { Writable } from 'node:stream';
import {
  assignAdminRole,
  createAdminRole,
  SYSTEM_ADMIN_ACCESS,
  type AdminPermission,
} from '@muziris/access';
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

describe.skipIf(!url)('catalog routes against PostgreSQL', () => {
  let handle: DatabaseHandle;
  let logs: string[];

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_catalog');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate catalog_product_sold_in, catalog_product, catalog_category, catalog_product_unit,
        access_admin_user_role, access_admin_role_permission, access_admin_role,
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
    return app().request(`/admin/v1/catalog${path}`, {
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

  it('requires an admin session', async () => {
    const res = await app().request('/admin/v1/catalog/products');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_signed_in' });
  });

  const ID = '00000000-0000-4000-8000-000000000000';

  it.each([
    ['GET', '/product-units', undefined, 'product.view'],
    ['GET', '/categories', undefined, 'product.view'],
    ['GET', '/products', undefined, 'product.view'],
    ['GET', `/products/${ID}`, undefined, 'product.view'],
    ['POST', '/product-units', { code: 'each', name: 'Each', precision: 0 }, 'product.manage'],
    ['POST', '/categories', { code: 'fasteners', name: 'Fasteners' }, 'product.manage'],
    ['PATCH', `/categories/${ID}`, { name: 'X' }, 'product.manage'],
    ['PUT', `/categories/${ID}/parent`, { parentId: null }, 'product.manage'],
    ['DELETE', `/categories/${ID}`, undefined, 'product.manage'],
    ['POST', '/products', { sku: 'A1', name: 'A', primaryUnitCode: 'each' }, 'product.manage'],
    ['PATCH', `/products/${ID}`, { name: 'X' }, 'product.manage'],
    ['PUT', `/products/${ID}/units`, { primaryUnitCode: 'each' }, 'product.manage'],
  ] as const)(
    '%s %s answers 403 without %s, and passes the permission check with it',
    async (method, path, body, permission) => {
      const other: AdminPermission =
        permission === 'product.view' ? 'customer.view' : 'product.view';
      const without = await signedInAdmin('meera@acme.example', [other]);
      const denied = await call(method, path, without, body);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      expect(await denied.json()).toMatchObject({ code: 'permission_denied' });

      const withIt = await signedInAdmin('asha@acme.example', [permission]);
      const allowed = await call(method, path, withIt, body);
      expect(allowed.status).not.toBe(403);
      expect(allowed.status).toBeLessThan(500);
    },
  );

  it('lets a product manager build a catalog end to end', async () => {
    const asha = await signedInAdmin('asha@acme.example', ['product.view', 'product.manage']);

    for (const unit of [
      { code: 'each', name: 'Each', precision: 0 },
      { code: 'kg', name: 'Kilogram', precision: 3 },
    ]) {
      expect((await call('POST', '/product-units', asha, unit)).status).toBe(201);
    }
    const units = await json<{ productUnits: unknown[] }>(
      await call('GET', '/product-units', asha),
    );
    expect(units.productUnits).toEqual([
      { code: 'each', name: 'Each', precision: 0 },
      { code: 'kg', name: 'Kilogram', precision: 3 },
    ]);

    const fasteners = await json<{ category: { id: string } }>(
      await call('POST', '/categories', asha, { code: 'fasteners', name: 'Fasteners' }),
    );
    const bolts = await json<{ category: { id: string } }>(
      await call('POST', '/categories', asha, {
        code: 'bolts',
        name: 'Bolts',
        parentId: fasteners.category.id,
      }),
    );
    const tree = await json<{ categories: { code: string; children: { code: string }[] }[] }>(
      await call('GET', '/categories', asha),
    );
    expect(tree.categories).toMatchObject([{ code: 'fasteners', children: [{ code: 'bolts' }] }]);

    const created = await call('POST', '/products', asha, {
      sku: 'BLT-M8-40',
      name: 'Hex bolt M8 x 40',
      categoryId: bolts.category.id,
      attributes: { material: 'stainless steel', thread_pitch_mm: '1.25' },
      primaryUnitCode: 'each',
      additionalUnitCodes: ['kg'],
    });
    expect(created.status).toBe(201);
    const { product } = await json<{ product: { id: string; status: string; units: unknown[] } }>(
      created,
    );
    expect(product).toMatchObject({
      status: 'disabled',
      primaryUnitCode: 'each',
      units: [
        { code: 'each', precision: 0 },
        { code: 'kg', precision: 3 },
      ],
    });
    expect(logs.some((l) => l.includes('catalog.product_created'))).toBe(true);

    const enabled = await call('PATCH', `/products/${product.id}`, asha, { status: 'enabled' });
    expect(await json(enabled)).toMatchObject({ product: { status: 'enabled' } });

    const listed = await call(
      'GET',
      `/products?categoryId=${fasteners.category.id}&includeSubcategories=true&status=enabled&limit=10`,
      asha,
    );
    expect(listed.status).toBe(200);
    expect(await json(listed)).toMatchObject({
      products: [{ sku: 'BLT-M8-40' }],
      nextAfter: null,
    });

    const reunit = await call('PUT', `/products/${product.id}/units`, asha, {
      primaryUnitCode: 'kg',
    });
    expect(await json(reunit)).toMatchObject({
      product: { primaryUnitCode: 'kg', units: [{ code: 'kg' }] },
    });

    expect((await call('GET', `/products/${product.id}`, asha)).status).toBe(200);
    expect((await call('DELETE', `/categories/${bolts.category.id}`, asha)).status).toBe(409);
  });

  it.each([
    [
      'a product unit with too much precision',
      'POST',
      '/product-units',
      { code: 'mg', name: 'mg', precision: 7 },
      400,
      'validation_failed',
    ],
    [
      'a quantity attribute as a JSON number',
      'POST',
      '/products',
      { sku: 'A1', name: 'A', primaryUnitCode: 'each', attributes: { weight_kg: 2.5 } },
      400,
      'validation_failed',
    ],
    [
      'a configurable product',
      'POST',
      '/products',
      { sku: 'A1', name: 'A', type: 'configurable', primaryUnitCode: 'each' },
      400,
      'validation_failed',
    ],
    [
      'an unknown product unit',
      'POST',
      '/products',
      { sku: 'A1', name: 'A', primaryUnitCode: 'litre' },
      404,
      'product_unit_not_found',
    ],
    [
      'an unknown category',
      'POST',
      '/products',
      { sku: 'A1', name: 'A', primaryUnitCode: 'each', categoryId: ID },
      404,
      'category_not_found',
    ],
    [
      'a SKU taken in another case',
      'POST',
      '/products',
      { sku: 'blt-1', name: 'A', primaryUnitCode: 'each' },
      409,
      'sku_taken',
    ],
    [
      'a product unit code that is taken',
      'POST',
      '/product-units',
      { code: 'each', name: 'Each', precision: 0 },
      409,
      'product_unit_code_taken',
    ],
    ['a missing product', 'GET', `/products/${ID}`, undefined, 404, 'product_not_found'],
    ['a malformed id', 'GET', "/products/1' or '1'='1", undefined, 400, 'validation_failed'],
    ['a bad page size', 'GET', '/products?limit=1000', undefined, 400, 'validation_failed'],
    ['a bad status filter', 'GET', '/products?status=deleted', undefined, 400, 'validation_failed'],
    [
      'changing the product type',
      'PATCH',
      `/products/${ID}`,
      { type: 'kit' },
      400,
      'validation_failed',
    ],
    [
      'moving a category under itself',
      'PUT',
      '/categories/{fasteners}/parent',
      { parentId: '{fasteners}' },
      409,
      'category_cycle',
    ],
  ] as const)('refuses %s', async (_label, method, rawPath, rawBody, status, code) => {
    const asha = await signedInAdmin('asha@acme.example', ['product.view', 'product.manage']);
    await call('POST', '/product-units', asha, { code: 'each', name: 'Each', precision: 0 });
    await call('POST', '/products', asha, { sku: 'BLT-1', name: 'Bolt', primaryUnitCode: 'each' });
    const fasteners = await json<{ category: { id: string } }>(
      await call('POST', '/categories', asha, { code: 'fasteners', name: 'Fasteners' }),
    );
    const fill = (s: string) => s.replaceAll('{fasteners}', fasteners.category.id);
    const body: unknown =
      rawBody === undefined ? undefined : JSON.parse(fill(JSON.stringify(rawBody)));
    const res = await call(method, fill(rawPath), asha, body);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
  });

  it('refuses state changes from an untrusted origin', async () => {
    const asha = await signedInAdmin('asha@acme.example', ['product.manage']);
    const res = await app().request('/admin/v1/catalog/categories', {
      method: 'POST',
      headers: {
        Cookie: asha,
        Origin: 'https://evil.example.net',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: 'evil', name: 'Evil' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'untrusted_origin' });
  });
});
