import { assignBuyerRole, createBuyerRole } from '@muziris/access';
import { createProduct, createProductUnit, type Product } from '@muziris/catalog';
import { addAddress, createCustomer, linkBuyerUser, type Address } from '@muziris/customers';
import {
  createDatabase,
  prepareTestDatabase,
  runMigrations,
  type DatabaseHandle,
} from '@muziris/db';
import { createUser } from '@muziris/identity';
import { toDecimalString } from '@muziris/money';
import { previewCheckout, SHIPPING_FLAT_RATE } from '@muziris/orders';
import { createOrganization, createWebsite, setSetting } from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  rebuildCombinedPrices,
} from '@muziris/pricing';
import {
  addExemption,
  addGstRate,
  addUsRate,
  addUsRegistration,
  setGstRegistration,
  tableTaxProvider,
} from '@muziris/tax';
import { rebuildVisibility } from '@muziris/visibility';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Known answers for a whole checkout: the price build, the combined price lookup with its
// quantity tiers, flat shipping and the tax engine reading its own tables (ADR 0011, 0016,
// 0017). The unit tables test each step with stand-ins; these run the steps together, as the
// API does, on PostgreSQL. Every answer is worked out by hand in the comment above its case.
//
// The rates are test values, not tax advice: 18% on HSN 8482 and 5% on HSN 4015 in India; in
// California 7.25% statewide (shipping not taxed) and 8.625% for ZIP codes starting 941
// (shipping taxed).

const url = process.env['TEST_DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const NOW = new Date('2026-11-20T06:00:00Z');

type Market = 'IN' | 'US';
type ShipTo = 'pune' | 'kochi' | 'sanFrancisco' | 'losAngeles' | 'austin';

interface KnownAnswer {
  title: string;
  market: Market;
  /** The exempt customer has a California resale certificate. */
  customer?: 'exempt';
  shipTo: ShipTo;
  /** Product SKU and quantity in each. */
  lines: readonly (readonly [string, string])[];
  expected: {
    unitPrices: readonly string[];
    subtotal: string;
    shipping: string;
    /** Each tax as [line number or null for shipping, name, rate, taxable, amount]. */
    taxes: readonly (readonly [number | null, string, string, string, string])[];
    tax: string;
    grandTotal: string;
    exemptionCertificate?: string;
  };
}

const BEARING_IN = 'BRG-6205-2RS';
const GLOVES_IN = 'GLV-NITRILE-L';
const BEARING_US = 'BRG-6205-2RS-US';
const GLOVES_US = 'GLV-NITRILE-L-US';

const KNOWN_ANSWERS: readonly KnownAnswer[] = [
  // 100 bearings reach the ₹410 tier: 41,000.00. Within Maharashtra, CGST and SGST at 9% each:
  // 3,690.00 twice. Shipping ₹250 takes the highest line rate, 18%: 22.50 twice.
  // Tax 7,425.00; total 41,000.00 + 250.00 + 7,425.00 = 48,675.00.
  {
    title: 'India, within the state, at the 100 tier',
    market: 'IN',
    shipTo: 'pune',
    lines: [[BEARING_IN, '100']],
    expected: {
      unitPrices: ['410.00'],
      subtotal: '41000.00',
      shipping: '250.00',
      taxes: [
        [1, 'CGST', '0.09', '41000.00', '3690.00'],
        [1, 'SGST', '0.09', '41000.00', '3690.00'],
        [null, 'CGST', '0.09', '250.00', '22.50'],
        [null, 'SGST', '0.09', '250.00', '22.50'],
      ],
      tax: '7425.00',
      grandTotal: '48675.00',
    },
  },
  // 99 bearings stay at the ₹450 list price: 44,550.00. 9% of it is 4,009.50, twice; 9% of
  // shipping is 22.50, twice. Tax 8,064.00; total 44,550.00 + 250.00 + 8,064.00 = 52,864.00.
  {
    title: 'India, one short of the tier, pays the list price',
    market: 'IN',
    shipTo: 'pune',
    lines: [[BEARING_IN, '99']],
    expected: {
      unitPrices: ['450.00'],
      subtotal: '44550.00',
      shipping: '250.00',
      taxes: [
        [1, 'CGST', '0.09', '44550.00', '4009.50'],
        [1, 'SGST', '0.09', '44550.00', '4009.50'],
        [null, 'CGST', '0.09', '250.00', '22.50'],
        [null, 'SGST', '0.09', '250.00', '22.50'],
      ],
      tax: '8064.00',
      grandTotal: '52864.00',
    },
  },
  // To Kerala, one IGST per line. Bearings 10 × 450.00 = 4,500.00, 18% = 810.00. Gloves
  // 7 × 95.50 = 668.50, 5% = 33.425, half up 33.43. Shipping at the highest rate, 18%: 45.00.
  // Tax 888.43; total 5,168.50 + 250.00 + 888.43 = 6,306.93.
  {
    title: 'India, to another state, two rates',
    market: 'IN',
    shipTo: 'kochi',
    lines: [
      [BEARING_IN, '10'],
      [GLOVES_IN, '7'],
    ],
    expected: {
      unitPrices: ['450.00', '95.50'],
      subtotal: '5168.50',
      shipping: '250.00',
      taxes: [
        [1, 'IGST', '0.18', '4500.00', '810.00'],
        [2, 'IGST', '0.05', '668.50', '33.43'],
        [null, 'IGST', '0.18', '250.00', '45.00'],
      ],
      tax: '888.43',
      grandTotal: '6306.93',
    },
  },
  // The same gloves within the state: 2.5% of 668.50 is 16.7125, which rounds to 16.71 per
  // half, so the halves sum to 33.42 where IGST is 33.43. Shipping at 5%: 6.25 twice.
  // Tax 45.92; total 668.50 + 250.00 + 45.92 = 964.42.
  {
    title: 'India, within the state, the halves round apart',
    market: 'IN',
    shipTo: 'pune',
    lines: [[GLOVES_IN, '7']],
    expected: {
      unitPrices: ['95.50'],
      subtotal: '668.50',
      shipping: '250.00',
      taxes: [
        [1, 'CGST', '0.025', '668.50', '16.71'],
        [1, 'SGST', '0.025', '668.50', '16.71'],
        [null, 'CGST', '0.025', '250.00', '6.25'],
        [null, 'SGST', '0.025', '250.00', '6.25'],
      ],
      tax: '45.92',
      grandTotal: '964.42',
    },
  },
  // San Francisco takes the 941 ZIP rate, 8.625%. Bearings 10 × 12.40 = 124.00, tax 10.695,
  // half up 10.70. Gloves are exempt: 5 × 8.00 = 40.00, no tax. Shipping $15.00 is taxed at
  // this rate: 1.29375, 1.29. Tax 11.99; total 164.00 + 15.00 + 11.99 = 190.99.
  {
    title: 'US, a ZIP rate that taxes shipping, with an exempt product',
    market: 'US',
    shipTo: 'sanFrancisco',
    lines: [
      [BEARING_US, '10'],
      [GLOVES_US, '5'],
    ],
    expected: {
      unitPrices: ['12.40', '8.00'],
      subtotal: '164.00',
      shipping: '15.00',
      taxes: [
        [1, 'CA sales tax', '0.08625', '124.00', '10.70'],
        [null, 'CA sales tax', '0.08625', '15.00', '1.29'],
      ],
      tax: '11.99',
      grandTotal: '190.99',
    },
  },
  // Los Angeles falls back to the 7.25% state rate, which does not tax shipping. 100 bearings
  // reach the $11.95 tier: 1,195.00, tax 86.6375, half up 86.64.
  // Total 1,195.00 + 15.00 + 86.64 = 1,296.64.
  {
    title: 'US, the state rate at the 100 tier, shipping untaxed',
    market: 'US',
    shipTo: 'losAngeles',
    lines: [[BEARING_US, '100']],
    expected: {
      unitPrices: ['11.95'],
      subtotal: '1195.00',
      shipping: '15.00',
      taxes: [[1, 'CA sales tax', '0.0725', '1195.00', '86.64']],
      tax: '86.64',
      grandTotal: '1296.64',
    },
  },
  // The seller has no Texas permit, so nothing is charged: 124.00 + 15.00 = 139.00.
  {
    title: 'US, a state without a permit, no tax',
    market: 'US',
    shipTo: 'austin',
    lines: [[BEARING_US, '10']],
    expected: {
      unitPrices: ['12.40'],
      subtotal: '124.00',
      shipping: '15.00',
      taxes: [],
      tax: '0.00',
      grandTotal: '139.00',
    },
  },
  // A valid California resale certificate makes the order tax free and is recorded:
  // 124.00 + 15.00 = 139.00.
  {
    title: 'US, an exemption certificate, no tax',
    market: 'US',
    customer: 'exempt',
    shipTo: 'losAngeles',
    lines: [[BEARING_US, '10']],
    expected: {
      unitPrices: ['12.40'],
      subtotal: '124.00',
      shipping: '15.00',
      taxes: [],
      tax: '0.00',
      grandTotal: '139.00',
      exemptionCertificate: 'CDTFA-230-RESALE-77',
    },
  },
];

describe.skipIf(!url)('checkout known answers against PostgreSQL', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, 'api_checkout_known_answers');
    await runMigrations(testUrl);
    handle = createDatabase({ url: testUrl, applicationName: 'muziris-test' });
  });

  beforeEach(async () => {
    const tables = await handle.db.execute<{ name: string }>(
      sql`select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
    );
    await handle.db.execute(
      sql.raw(`truncate ${tables.map((t) => t.name).join(', ')} restart identity cascade`),
    );
  });

  afterAll(async () => {
    await handle.close();
  });

  /** An Indian website selling from Maharashtra and a US one with a California permit. */
  async function world() {
    const db = handle.db;
    const admin = await createUser(db, {
      realm: 'admin',
      email: 'meera@muziris.example',
      displayName: 'Meera',
      password: PASSWORD,
    });
    const org = await createOrganization(db, 'Muziris Industrial');
    const site = (code: string, countryCode: Market) =>
      createWebsite(db, {
        organizationId: org.id,
        code,
        name: code,
        countryCode,
        defaultCurrency: countryCode === 'IN' ? 'INR' : 'USD',
        defaultLocale: countryCode === 'IN' ? 'en-IN' : 'en-US',
        timeZone: countryCode === 'IN' ? 'Asia/Kolkata' : 'America/Los_Angeles',
      });
    const websites = { IN: await site('acme-in', 'IN'), US: await site('acme-us', 'US') };
    await createProductUnit(db, { code: 'each', name: 'Each', precision: 0 });

    const product = (
      sku: string,
      tax: { hsnSacCode: string } | { usTaxCategory: 'general' | 'exempt' },
    ) =>
      createProduct(db, {
        sku,
        name: sku,
        status: 'enabled',
        attributes: {},
        primaryUnitCode: 'each',
        ...tax,
      });
    const products: Record<string, Product> = {
      [BEARING_IN]: await product(BEARING_IN, { hsnSacCode: '84821011' }),
      [GLOVES_IN]: await product(GLOVES_IN, { hsnSacCode: '40151900' }),
      [BEARING_US]: await product(BEARING_US, { usTaxCategory: 'general' }),
      [GLOVES_US]: await product(GLOVES_US, { usTaxCategory: 'exempt' }),
    };

    /** A website-wide price list: [SKU, minimum quantity, amount]. */
    async function priceList(market: Market, prices: [string, string, string][]) {
      const list = await createPriceList(db, {
        name: `List price ${market}`,
        currency: market === 'IN' ? 'INR' : 'USD',
      });
      for (const [sku, minQuantity, amount] of prices) {
        await addPrice(db, list.id, {
          productId: products[sku]!.id,
          unitCode: 'each',
          minQuantity,
          amount,
        });
      }
      await createAssignment(db, {
        priceListId: list.id,
        websiteId: websites[market].id,
        target: 'website',
      });
    }
    await priceList('IN', [
      [BEARING_IN, '1', '450.00'],
      [BEARING_IN, '100', '410.00'],
      [GLOVES_IN, '1', '95.50'],
    ]);
    await priceList('US', [
      [BEARING_US, '1', '12.40'],
      [BEARING_US, '100', '11.95'],
      [GLOVES_US, '1', '8.00'],
    ]);
    for (const [market, amount] of [
      ['IN', '250.00'],
      ['US', '15.00'],
    ] as const) {
      await setSetting(
        db,
        SHIPPING_FLAT_RATE,
        { type: 'website', id: websites[market].id },
        {
          amount,
        },
      );
    }

    await setGstRegistration(db, websites.IN.id, { gstin: '27AAPFU0939F1ZV' });
    await addGstRate(db, admin.id, {
      codePrefix: '8482',
      ratePercent: '18',
      validFrom: '2025-04-01',
    });
    await addGstRate(db, admin.id, {
      codePrefix: '4015',
      ratePercent: '5',
      validFrom: '2025-04-01',
    });
    await addUsRegistration(db, websites.US.id, { stateCode: 'CA', permitNumber: 'SR-123-456789' });
    await addUsRate(db, admin.id, {
      stateCode: 'CA',
      ratePercent: '7.25',
      shippingTaxable: false,
      validFrom: '2025-04-01',
    });
    await addUsRate(db, admin.id, {
      stateCode: 'CA',
      zipPrefix: '941',
      ratePercent: '8.625',
      shippingTaxable: true,
      validFrom: '2025-04-01',
    });
    await Promise.all([rebuildVisibility(db), rebuildCombinedPrices(db)]);

    const orderer = await createBuyerRole(db, {
      code: 'orderer',
      name: 'Orderer',
      grants: [{ permission: 'order.place', accessLevel: 'my_customer' }],
    });
    async function customer(name: string, email: string) {
      const created = await createCustomer(db, { name });
      const user = await createUser(db, {
        realm: 'buyer',
        email,
        displayName: name,
        password: PASSWORD,
      });
      await linkBuyerUser(db, created.id, email);
      await assignBuyerRole(db, user.id, orderer.id);
      return { id: created.id, buyerUserId: user.id };
    }
    const kaveri = await customer('Kaveri Engineering', 'priya@kaveri.example');
    const bay = await customer('Bay Industrial', 'sam@bayindustrial.example');
    const resale = await customer('Golden State Resale', 'ana@goldenstate.example');
    await addExemption(db, admin.id, {
      customerId: resale.id,
      stateCode: 'CA',
      certificateNumber: 'CDTFA-230-RESALE-77',
      expiresOn: '2027-12-31',
    });

    /** Addresses by customer id and ship-to. */
    const addresses = new Map<string, Address>();
    async function address(
      customerId: string,
      shipTo: ShipTo,
      place: { countryCode: Market; city: string; regionCode: string; postalCode: string },
    ) {
      const added = await addAddress(db, {
        customerId,
        label: shipTo,
        line1: '1 Test Road',
        ...place,
      });
      addresses.set(`${customerId} ${shipTo}`, added);
    }
    await address(kaveri.id, 'pune', {
      countryCode: 'IN',
      city: 'Pune',
      regionCode: '27',
      postalCode: '411026',
    });
    await address(kaveri.id, 'kochi', {
      countryCode: 'IN',
      city: 'Kochi',
      regionCode: '32',
      postalCode: '682003',
    });
    for (const c of [bay, resale]) {
      await address(c.id, 'sanFrancisco', {
        countryCode: 'US',
        city: 'San Francisco',
        regionCode: 'CA',
        postalCode: '94103',
      });
      await address(c.id, 'losAngeles', {
        countryCode: 'US',
        city: 'Los Angeles',
        regionCode: 'CA',
        postalCode: '90012',
      });
      await address(c.id, 'austin', {
        countryCode: 'US',
        city: 'Austin',
        regionCode: 'TX',
        postalCode: '78701',
      });
    }
    return { websites, products, kaveri, bay, resale, addresses };
  }

  it.each(KNOWN_ANSWERS)('$title', async (known) => {
    const w = await world();
    const buyer = known.market === 'IN' ? w.kaveri : known.customer === 'exempt' ? w.resale : w.bay;
    const shipTo = w.addresses.get(`${buyer.id} ${known.shipTo}`)!;
    const result = await previewCheckout(
      handle.db,
      {
        buyerUserId: buyer.buyerUserId,
        request: {
          websiteId: w.websites[known.market].id,
          lines: known.lines.map(([sku, quantity]) => ({
            productId: w.products[sku]!.id,
            unitCode: 'each',
            quantity,
          })),
          billingAddressId: shipTo.id,
          shippingAddressId: shipTo.id,
        },
        now: NOW,
      },
      { tax: tableTaxProvider(handle.db) },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.refusal));
    const t = result.preview.totals;
    const e = known.expected;
    expect(t.lines.map((l) => toDecimalString(l.unitPrice))).toEqual(e.unitPrices);
    expect(toDecimalString(t.subtotal)).toBe(e.subtotal);
    expect(toDecimalString(t.shipping)).toBe(e.shipping);
    expect(
      t.taxes.map((x) => [
        x.lineNo,
        x.name,
        x.rate,
        toDecimalString(x.taxable),
        toDecimalString(x.amount),
      ]),
    ).toEqual(e.taxes);
    expect(toDecimalString(t.tax)).toBe(e.tax);
    expect(toDecimalString(t.grandTotal)).toBe(e.grandTotal);
    expect(t.exemptionCertificate).toBe(e.exemptionCertificate ?? null);
  });
});
