import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clearSetting,
  createOrganization,
  createWebsite,
  defineSetting,
  findWebsite,
  findWebsiteByCode,
  getSetting,
  listWebsites,
  setSetting,
  SettingScopeNotAllowedError,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];

const paymentTermDays = defineSetting({
  key: 'payment.default_term_days',
  description: 'Default payment term for invoices, in days',
  schema: z.number().int().min(0).max(365),
  defaultValue: 30,
  allowedScopes: ['global', 'website', 'customer_group', 'customer'],
});

describe.skipIf(!url)('platform module against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'platform');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate platform_config_value, platform_website, platform_organization cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  async function seedWebsite() {
    const org = await createOrganization(handle.db, 'Acme Industrial Supply');
    const site = await createWebsite(handle.db, {
      organizationId: org.id,
      code: 'acme-in',
      name: 'Acme India',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      defaultLocale: 'en-IN',
      timeZone: 'Asia/Kolkata',
    });
    return { org, site };
  }

  it('creates and finds websites', async () => {
    const { org, site } = await seedWebsite();
    expect(site.unitSystem).toBe('metric');
    expect(await findWebsiteByCode(handle.db, 'acme-in')).toMatchObject({ id: site.id });
    expect(await findWebsite(handle.db, site.id)).toMatchObject({ code: 'acme-in' });
    expect(await findWebsite(handle.db, '00000000-0000-4000-8000-000000000000')).toBeUndefined();
    expect(await findWebsite(handle.db, 'not-a-uuid')).toBeUndefined();
    expect((await listWebsites(handle.db, org.id)).map((w) => w.code)).toEqual(['acme-in']);
  });

  it.each([
    ['code', 'Acme IN'],
    ['countryCode', 'India'],
    ['defaultCurrency', 'XYZ'],
    ['defaultLocale', 'english'],
    ['timeZone', 'Mars/Olympus'],
  ])('rejects an invalid %s before it reaches the database', async (field, value) => {
    const org = await createOrganization(handle.db, 'Acme');
    await expect(
      createWebsite(handle.db, {
        organizationId: org.id,
        code: 'acme-us',
        name: 'Acme US',
        countryCode: 'US',
        defaultCurrency: 'USD',
        defaultLocale: 'en-US',
        timeZone: 'America/Chicago',
        [field]: value,
      }),
    ).rejects.toThrow();
  });

  it('enforces website codes in the database as well', async () => {
    const org = await createOrganization(handle.db, 'Acme');
    await expect(
      handle.db.execute(
        sql`insert into platform_website (organization_id, code, name, country_code, default_currency, default_locale, time_zone)
            values (${org.id}, 'BAD CODE', 'x', 'IN', 'INR', 'en-IN', 'Asia/Kolkata')`,
      ),
    ).rejects.toThrow();
  });

  it('reads a string setting back as the string stored, even when it looks like JSON', async () => {
    const { org, site } = await seedWebsite();
    const label = defineSetting({
      key: 'test.label',
      description: 'A free-text label',
      schema: z.string(),
      defaultValue: '',
      allowedScopes: ['website', 'global'],
    });
    const context = { organizationId: org.id, websiteId: site.id };
    for (const value of ['250.00', '123', 'true', 'null', '{"a":1}', '[1]', '"quoted"', 'MZ']) {
      await setSetting(handle.db, label, { type: 'website', id: site.id }, value);
      expect(await getSetting(handle.db, label, context)).toEqual({ value, source: 'website' });
    }
  });

  it('stores, overrides, inherits and clears a setting across scopes', async () => {
    const { org, site } = await seedWebsite();
    const context = { organizationId: org.id, websiteId: site.id };

    expect(await getSetting(handle.db, paymentTermDays, context)).toEqual({
      value: 30,
      source: 'default',
    });

    await setSetting(handle.db, paymentTermDays, { type: 'global' }, 45);
    expect(await getSetting(handle.db, paymentTermDays, context)).toEqual({
      value: 45,
      source: 'global',
    });

    await setSetting(handle.db, paymentTermDays, { type: 'website', id: site.id }, 15);
    expect(await getSetting(handle.db, paymentTermDays, context)).toEqual({
      value: 15,
      source: 'website',
    });

    // Upsert replaces the value at the same scope rather than adding a second row.
    await setSetting(handle.db, paymentTermDays, { type: 'website', id: site.id }, 10);
    expect((await getSetting(handle.db, paymentTermDays, context)).value).toBe(10);

    await clearSetting(handle.db, paymentTermDays, { type: 'website', id: site.id });
    expect(await getSetting(handle.db, paymentTermDays, context)).toEqual({
      value: 45,
      source: 'global',
    });
  });

  it('refuses a scope the setting does not allow and values that fail the schema', async () => {
    const { org } = await seedWebsite();
    await expect(
      setSetting(handle.db, paymentTermDays, { type: 'organization', id: org.id }, 20),
    ).rejects.toBeInstanceOf(SettingScopeNotAllowedError);
    await expect(setSetting(handle.db, paymentTermDays, { type: 'global' }, 999)).rejects.toThrow();
  });

  it('keeps one global row per key even though scope_id is null', async () => {
    await setSetting(handle.db, paymentTermDays, { type: 'global' }, 40);
    await setSetting(handle.db, paymentTermDays, { type: 'global' }, 50);
    const rows = await handle.db.execute(
      sql`select count(*)::int as n from platform_config_value where key = ${paymentTermDays.key}`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});
