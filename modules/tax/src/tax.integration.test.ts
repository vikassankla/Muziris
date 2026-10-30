import { createCustomer } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { moneyFromDecimal, toDecimalString } from '@muziris/money';
import type { TaxRequest } from '@muziris/orders';
import { createOrganization, createWebsite } from '@muziris/platform';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addExemption,
  addGstRate,
  addUsRate,
  addUsRegistration,
  deleteRegistration,
  endGstRate,
  importUsRates,
  listGstRates,
  listRegistrations,
  listUsRates,
  setGstRegistration,
  tableTaxProvider,
  TaxError,
} from './index.js';

const url = process.env['TEST_DATABASE_URL'];
const ADMIN = randomUUID();
const GSTIN = '27AAPFU0939F1ZV';

describe.skipIf(!url)('tax against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'tax');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate tax_exemption, tax_us_rate, tax_gst_rate, tax_registration, customer_customer,
        customer_group, platform_website, platform_organization cascade`,
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  async function websites() {
    const org = await createOrganization(handle.db, 'Muziris Industrial');
    const site = (code: string, countryCode: string, currency: string, timeZone: string) =>
      createWebsite(handle.db, {
        organizationId: org.id,
        code,
        name: code,
        countryCode,
        defaultCurrency: currency,
        defaultLocale: countryCode === 'IN' ? 'en-IN' : 'en-US',
        timeZone,
      });
    return {
      india: await site('muziris-in', 'IN', 'INR', 'Asia/Kolkata'),
      us: await site('muziris-us', 'US', 'USD', 'America/Los_Angeles'),
    };
  }

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (error instanceof TaxError) return error.code;
      throw error;
    }
    throw new Error('Expected a TaxError');
  }

  describe('registrations', () => {
    it('keeps one GSTIN per Indian website and permits per state for a US one', async () => {
      const { india, us } = await websites();
      await setGstRegistration(handle.db, india.id, { gstin: GSTIN.toLowerCase() });
      // A new GSTIN in another state replaces the first.
      await setGstRegistration(handle.db, india.id, { gstin: '29AAPFU0939F1ZR' });
      expect((await listRegistrations(handle.db, india.id)).map((r) => r.number)).toEqual([
        '29AAPFU0939F1ZR',
      ]);

      const ca = await addUsRegistration(handle.db, us.id, {
        stateCode: 'ca',
        permitNumber: 'CA-SR-123',
      });
      await addUsRegistration(handle.db, us.id, { stateCode: 'NY', permitNumber: 'NY-456' });
      expect(
        await refusal(addUsRegistration(handle.db, us.id, { stateCode: 'CA', permitNumber: 'x' })),
      ).toBe('registration_taken');
      expect(
        (await listRegistrations(handle.db, us.id)).map((r) => [r.regionCode, r.number]),
      ).toEqual([
        ['CA', 'CA-SR-123'],
        ['NY', 'NY-456'],
      ]);
      await deleteRegistration(handle.db, ca.id);
      expect(await refusal(deleteRegistration(handle.db, ca.id))).toBe('registration_not_found');
    });

    it('refuses a GSTIN on a US website, a permit on an Indian one, and a bad GSTIN', async () => {
      const { india, us } = await websites();
      expect(await refusal(setGstRegistration(handle.db, us.id, { gstin: GSTIN }))).toBe(
        'wrong_regime',
      );
      expect(
        await refusal(
          addUsRegistration(handle.db, india.id, { stateCode: 'CA', permitNumber: 'x' }),
        ),
      ).toBe('wrong_regime');
      await expect(
        setGstRegistration(handle.db, india.id, { gstin: '27AAPFU0939F1ZX' }),
      ).rejects.toThrow(/check character/);
      expect(await refusal(setGstRegistration(handle.db, randomUUID(), { gstin: GSTIN }))).toBe(
        'website_not_found',
      );
    });
  });

  describe('rates', () => {
    it('stores percentages as fractions, and refuses an overlapping period', async () => {
      const first = await addGstRate(handle.db, ADMIN, {
        codePrefix: '8482',
        ratePercent: '18',
        validFrom: '2025-09-22',
      });
      expect(first).toMatchObject({ rate: '0.18', ratePercent: '18', validTo: null });
      expect(
        await refusal(
          addGstRate(handle.db, ADMIN, {
            codePrefix: '8482',
            ratePercent: '5',
            validFrom: '2026-12-01',
          }),
        ),
      ).toBe('rate_overlaps');

      // End the first, then the new one fits.
      const editor = randomUUID();
      const ended = await endGstRate(handle.db, editor, first.id, { validTo: '2026-12-01' });
      expect(ended).toMatchObject({ createdBy: ADMIN, updatedBy: editor });
      await addGstRate(handle.db, ADMIN, {
        codePrefix: '8482',
        ratePercent: '5',
        validFrom: '2026-12-01',
      });
      // A different prefix never clashes.
      await addGstRate(handle.db, ADMIN, {
        codePrefix: '84',
        ratePercent: '12',
        validFrom: '2025-09-22',
      });

      expect(
        (await listGstRates(handle.db, { on: '2026-11-30' })).map((r) => [
          r.codePrefix,
          r.ratePercent,
        ]),
      ).toEqual([
        ['84', '12'],
        ['8482', '18'],
      ]);
      expect(
        (await listGstRates(handle.db, { on: '2026-12-01' })).map((r) => r.ratePercent),
      ).toEqual(['12', '5']);
      expect(await refusal(endGstRate(handle.db, ADMIN, ended.id, { validTo: null }))).toBe(
        'rate_overlaps',
      );
    });

    it('lets only one of two racing admins enter an overlapping rate', async () => {
      const results = await Promise.allSettled(
        ['18', '12'].map((ratePercent) =>
          addGstRate(handle.db, ADMIN, {
            codePrefix: '9403',
            ratePercent,
            validFrom: '2026-01-01',
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await listGstRates(handle.db, { codePrefix: '9403' })).toHaveLength(1);
    });

    it('imports a US rates CSV whole, or not at all', async () => {
      const header = 'state,zip_prefix,rate_percent,shipping_taxable,valid_from,valid_to';
      const good = [
        header,
        'CA,,7.25,false,2026-01-01,',
        'CA,941,8.625,true,2026-01-01,',
        'NY,,4,true,2026-01-01,2027-01-01',
      ].join('\n');
      expect(await importUsRates(handle.db, ADMIN, good)).toEqual({ imported: 3 });
      expect(
        (await listUsRates(handle.db, { stateCode: 'CA' })).map((r) => [
          r.zipPrefix,
          r.rate,
          r.shippingTaxable,
        ]),
      ).toEqual([
        ['941', '0.08625', true],
        [null, '0.0725', false],
      ]);

      const bad = [header, 'TX,,6.25,false,2026-01-01,', 'XX,,1,maybe,2026-01-01,'].join('\n');
      const error = await importUsRates(handle.db, ADMIN, bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TaxError);
      expect((error as TaxError).rows.map((r) => r.row)).toEqual([2]);
      const clash = [header, 'TX,,6.25,false,2026-01-01,', 'CA,,7.5,false,2026-06-01,'].join('\n');
      expect(await refusal(importUsRates(handle.db, ADMIN, clash))).toBe('invalid_import');
      // Neither file left a Texas rate behind.
      expect(await listUsRates(handle.db, { stateCode: 'TX' })).toEqual([]);
    });
  });

  describe('the provider', () => {
    function request(
      websiteId: string,
      country: 'IN' | 'US',
      customerId: string,
      shipTo: { regionCode: string; postalCode: string },
    ): TaxRequest {
      const currency = country === 'IN' ? 'INR' : 'USD';
      return {
        websiteId,
        websiteCountryCode: country,
        websiteTimeZone: country === 'IN' ? 'Asia/Kolkata' : 'America/Los_Angeles',
        customerId,
        currency,
        billTo: { countryCode: country, gstin: null, ...shipTo },
        shipTo: { countryCode: country, gstin: null, ...shipTo },
        now: new Date('2026-11-20T06:00:00Z'),
        lines: [
          {
            lineNo: 1,
            productId: randomUUID(),
            net: moneyFromDecimal('4100.00', currency),
            hsnSacCode: '84821011',
            usTaxCategory: null,
          },
        ],
        orderDiscount: moneyFromDecimal('0', currency),
        shipping: moneyFromDecimal('250.00', currency),
      };
    }

    it('charges GST from the tables, by the longest prefix', async () => {
      const { india } = await websites();
      await setGstRegistration(handle.db, india.id, { gstin: GSTIN });
      await addGstRate(handle.db, ADMIN, {
        codePrefix: '84',
        ratePercent: '12',
        validFrom: '2025-09-22',
      });
      await addGstRate(handle.db, ADMIN, {
        codePrefix: '8482',
        ratePercent: '18',
        validFrom: '2025-09-22',
      });
      const result = await tableTaxProvider(handle.db).calculate(
        request(india.id, 'IN', randomUUID(), { regionCode: '27', postalCode: '411026' }),
      );
      expect(result.sellerTaxId).toBe(GSTIN);
      expect(
        result.lines.map((t) => [t.lineNo, t.name, t.rate, toDecimalString(t.amount)]),
      ).toEqual([
        [1, 'CGST', '0.09', '369.00'],
        [1, 'SGST', '0.09', '369.00'],
        [null, 'CGST', '0.09', '22.50'],
        [null, 'SGST', '0.09', '22.50'],
      ]);
    });

    it('charges US sales tax, or records an exemption certificate', async () => {
      const { us } = await websites();
      const customer = await createCustomer(handle.db, { name: 'Bay Area Supply' });
      await addUsRegistration(handle.db, us.id, { stateCode: 'CA', permitNumber: 'CA-SR-123' });
      await addUsRate(handle.db, ADMIN, {
        stateCode: 'CA',
        ratePercent: '7.25',
        shippingTaxable: false,
        validFrom: '2026-01-01',
      });
      const provider = tableTaxProvider(handle.db);
      const req = request(us.id, 'US', customer.id, { regionCode: 'CA', postalCode: '90012' });
      expect((await provider.calculate(req)).lines.map((t) => toDecimalString(t.amount))).toEqual([
        '297.25',
      ]);

      await addExemption(handle.db, ADMIN, {
        customerId: customer.id,
        stateCode: 'CA',
        certificateNumber: 'CDTFA-230-77',
      });
      expect(await provider.calculate(req)).toMatchObject({
        lines: [],
        sellerTaxId: 'CA-SR-123',
        exemptionCertificate: 'CDTFA-230-77',
      });
      expect(
        await refusal(
          addExemption(handle.db, ADMIN, {
            customerId: customer.id,
            stateCode: 'CA',
            certificateNumber: 'again',
          }),
        ),
      ).toBe('exemption_taken');
      expect(
        await refusal(
          addExemption(handle.db, ADMIN, {
            customerId: randomUUID(),
            stateCode: 'CA',
            certificateNumber: 'x',
          }),
        ),
      ).toBe('customer_not_found');
    });
  });
});
