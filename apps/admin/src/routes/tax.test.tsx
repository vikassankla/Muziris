import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  json,
  mockApi,
  problem,
  renderApp,
  signedIn,
  WEBSITES,
  type MockRequest,
} from '../test/mock-api.js';

const [INDIA, US] = WEBSITES;
const CUSTOMER_ID = '7c1e0a11-0000-4000-8000-0000000000c9';

const INDIA_READINESS = {
  websiteId: INDIA.id,
  countryCode: 'IN',
  day: '2026-11-02',
  ready: false,
  items: [
    { code: 'gst_registration_missing', ok: false, count: 1, examples: [] },
    {
      code: 'products_missing_tax_code',
      ok: false,
      count: 3,
      examples: [{ id: 'p1', sku: 'BRG-6204', name: 'Ball bearing 6204' }],
    },
    { code: 'tax_codes_without_rate', ok: true, count: 0, examples: [] },
  ],
};
const US_READINESS = {
  websiteId: US.id,
  countryCode: 'US',
  day: '2026-11-02',
  ready: true,
  items: [
    { code: 'us_permit_missing', ok: true, count: 0, examples: [] },
    { code: 'states_without_rate', ok: true, count: 0, examples: [] },
  ],
};
const GST_RATE = {
  id: '7c1e0a11-0000-4000-8000-0000000000a1',
  codePrefix: '8482',
  ratePercent: '18',
  validFrom: '2025-04-01',
  validTo: null,
};
const PERMIT = {
  id: '7c1e0a11-0000-4000-8000-0000000000a2',
  websiteId: US.id,
  regime: 'us_sales_tax',
  regionCode: 'TX',
  number: 'TX-123',
};
const US_RATE = {
  id: '7c1e0a11-0000-4000-8000-0000000000a3',
  stateCode: 'TX',
  zipPrefix: null,
  ratePercent: '6.25',
  shippingTaxable: true,
  validFrom: '2025-01-01',
  validTo: null,
};
const EXEMPTION = {
  id: '7c1e0a11-0000-4000-8000-0000000000a4',
  customerId: CUSTOMER_ID,
  stateCode: 'TX',
  certificateNumber: 'EX-77',
  expiresOn: '2027-12-31',
};

function taxApi(permissions: string[], extra: Record<string, (r: MockRequest) => Response> = {}) {
  return mockApi({
    ...signedIn(permissions),
    'GET /tax/readiness': (r) =>
      json({ readiness: r.query.get('websiteId') === US.id ? US_READINESS : INDIA_READINESS }),
    [`GET /tax/websites/${INDIA.id}/registrations`]: () => json({ registrations: [] }),
    [`GET /tax/websites/${US.id}/registrations`]: () => json({ registrations: [PERMIT] }),
    'GET /tax/gst-rates': () => json({ rates: [GST_RATE] }),
    'GET /tax/us-rates': () => json({ rates: [US_RATE] }),
    'GET /tax/exemptions': () => json({ exemptions: [EXEMPTION] }),
    'GET /customers': () =>
      json({
        customers: [
          {
            id: CUSTOMER_ID,
            name: 'Lone Star Supply',
            parentId: null,
            groupId: null,
            status: 'active',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        nextAfter: null,
      }),
    ...extra,
  });
}

async function chooseUs() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Website: India' }));
  await user.click(await screen.findByRole('menuitemradio', { name: /United States/ }));
  return user;
}

describe('tax', () => {
  it('shows what would refuse checkout, linked to where it is fixed', async () => {
    taxApi(['tax.view']);
    renderApp('/tax');
    expect(
      await screen.findByText('Checkout refuses orders on this website until these are fixed.'),
    ).toBeTruthy();
    expect(screen.getByText('The website has no GSTIN')).toBeTruthy();
    expect(screen.getByText(/BRG-6204 Ball bearing 6204, and more/)).toBeTruthy();
    expect(screen.getByText('A GST rate covers every code in use today')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Show these products' }).getAttribute('href'),
    ).toContain('missingTaxCode=true');
    // Read-only without tax.manage.
    await userEvent.click(screen.getByRole('tab', { name: 'Rates' }));
    expect(await screen.findByText('8482')).toBeTruthy();
    expect(screen.getByText('From 1 Apr 2025')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add rate' })).toBeNull();
  });

  it('saves the GSTIN, showing its state', async () => {
    const requests = taxApi(['tax.view', 'tax.manage'], {
      [`PUT /tax/websites/${INDIA.id}/gst-registration`]: () =>
        json({
          registration: {
            id: 'r1',
            websiteId: INDIA.id,
            regime: 'gst',
            regionCode: '27',
            number: '27AAPFU0939F1ZV',
          },
        }),
    });
    renderApp('/tax?tab=registration');
    const field = await screen.findByLabelText('GSTIN');
    fireEvent.change(field, { target: { value: '27aapfu0939f1zv' } });
    expect(screen.getByText('State: Maharashtra')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save GSTIN' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        gstin: '27AAPFU0939F1ZV',
      });
    });
  });

  it('adds a GST rate with an inclusive last day', async () => {
    const requests = taxApi(['tax.view', 'tax.manage'], {
      'POST /tax/gst-rates': () => json({ rate: { ...GST_RATE, id: 'new' } }, 201),
    });
    renderApp('/tax?tab=rates');
    await userEvent.click(await screen.findByRole('button', { name: 'Add rate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a GST rate' });
    fireEvent.change(within(dialog).getByLabelText('HSN or SAC prefix'), {
      target: { value: '8483' },
    });
    fireEvent.change(within(dialog).getByLabelText('Rate (%)'), { target: { value: '12' } });
    fireEvent.change(within(dialog).getByLabelText('First day'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Last day/), {
      target: { value: '2026-12-31' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rate' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        codePrefix: '8483',
        ratePercent: '12',
        validFrom: '2026-12-01',
        validTo: '2027-01-01',
      });
    });
  });

  it('shows US rates, the import’s row errors and exemption certificates', async () => {
    const requests = taxApi(['tax.view', 'tax.manage'], {
      'POST /tax/us-rates/import': () =>
        problem(
          422,
          'invalid_import',
          'The file has rows that are not valid; nothing was imported',
          {
            errors: [{ path: 'row 2', message: 'Unknown state ZZ' }],
          },
        ),
    });
    renderApp('/tax?tab=rates');
    const user = await chooseUs();
    expect(await screen.findByText('6.25%')).toBeTruthy();
    expect(screen.getByText('Statewide')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Import CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import US rates' });
    const file = new File(
      ['state,zip_prefix,rate_percent,shipping_taxable,valid_from,valid_to\n'],
      'rates.csv',
      {
        type: 'text/csv',
      },
    );
    await user.upload(within(dialog).getByLabelText('CSV file'), file);
    await waitFor(() => {
      expect(
        within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled,
      ).toBe(false);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByText('Row 2: Unknown state ZZ')).toBeTruthy();
    expect(requests.find((r) => r.path === '/tax/us-rates/import')?.body).toContain('state,');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('tab', { name: 'Exemptions' }));
    expect(await screen.findByRole('link', { name: 'Lone Star Supply' })).toBeTruthy();
    expect(screen.getByText('EX-77')).toBeTruthy();
  });
});

describe('product tax codes', () => {
  const PRODUCT = {
    id: 'p1',
    sku: 'BRG-6204',
    name: 'Ball bearing 6204',
    type: 'simple',
    status: 'enabled',
    categoryId: null,
    attributes: {},
    primaryUnitCode: 'each',
    units: [{ code: 'each', name: 'Each', precision: 0 }],
    hsnSacCode: null,
    usTaxCategory: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  it('shows the GST rate covering the code and saves it', async () => {
    const requests = mockApi({
      ...signedIn(['product.view', 'product.manage', 'tax.view']),
      'GET /catalog/products/p1': () => json({ product: PRODUCT }),
      'GET /catalog/categories': () => json({ categories: [] }),
      'GET /catalog/product-units': () => json({ productUnits: PRODUCT.units }),
      'GET /tax/gst-rates': () => json({ rates: [GST_RATE] }),
      'PATCH /catalog/products/p1': () => json({ product: { ...PRODUCT, hsnSacCode: '84821011' } }),
    });
    renderApp('/products/p1');
    const field = await screen.findByLabelText(/^HSN or SAC code/);
    fireEvent.change(field, { target: { value: '848' } });
    expect(
      await screen.findByText(
        'Use an HSN code of 4, 6 or 8 digits, or a SAC code of 6 digits starting 99.',
      ),
    ).toBeTruthy();
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.change(field, { target: { value: '998314' } });
    expect(
      await screen.findByText('No GST rate covers this code today, so checkout refuses it.'),
    ).toBeTruthy();
    fireEvent.change(field, { target: { value: '84821011' } });
    expect(await screen.findByText('GST 18% today, from the rate for 8482.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'US tax category' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
        hsnSacCode: '84821011',
      });
    });
  });
});
