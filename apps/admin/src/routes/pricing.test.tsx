import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn } from '../test/mock-api.js';

const LIST = {
  id: '7c1e0a11-0000-4000-8000-0000000000a1',
  name: 'India list price',
  currency: 'INR',
  activeFrom: '2025-12-31T18:30:00.000Z',
  activeUntil: null,
  status: 'active',
  priceCount: 2,
  assignmentCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const PRICE = {
  id: '7c1e0a11-0000-4000-8000-0000000000b1',
  priceListId: LIST.id,
  productId: '7c1e0a11-0000-4000-8000-0000000000c1',
  sku: 'BRG-6205-2RS',
  productName: 'Ball bearing 6205-2RS',
  unitCode: 'each',
  minQuantity: '1',
  amount: '450.00',
  currency: 'INR',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const TIER = {
  ...PRICE,
  id: '7c1e0a11-0000-4000-8000-0000000000b2',
  minQuantity: '100',
  amount: '410.00',
};
const ASSIGNMENT = {
  id: '7c1e0a11-0000-4000-8000-0000000000d1',
  priceListId: LIST.id,
  websiteId: '7c1e0a11-0000-4000-8000-0000000000e1',
  websiteName: 'India',
  target: 'customer_group',
  targetId: '7c1e0a11-0000-4000-8000-0000000000f1',
  targetName: 'Distributors',
  priority: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const WAITING = { build: { pendingChanges: 3, lastBuild: null, job: 'idle' } };
const BUILT = { build: { pendingChanges: 0, lastBuild: null, job: 'idle' } };

const detail = {
  [`GET /pricing/price-lists/${LIST.id}`]: () => json({ priceList: LIST }),
  [`GET /pricing/price-lists/${LIST.id}/prices`]: () =>
    json({ prices: [PRICE, TIER], nextAfter: null }),
  'GET /pricing/assignments': () => json({ assignments: [ASSIGNMENT], nextAfter: null }),
};

describe('price lists', () => {
  it('lists price lists with the build banner, and builds prices', async () => {
    let built = false;
    mockApi({
      ...signedIn(['price_list.view', 'price_list.manage']),
      'GET /pricing/price-lists': () => json({ priceLists: [LIST], nextAfter: null }),
      'GET /pricing/build': () => json(built ? BUILT : WAITING),
      'POST /pricing/build': () => {
        built = true;
        return json({ build: {} });
      },
    });
    renderApp('/price-lists');
    expect(await screen.findByRole('link', { name: 'India list price' })).toBeTruthy();
    expect(screen.getByText('From 1 Jan 2026')).toBeTruthy();
    expect(screen.getByText('3 changes waiting for the price build')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Build prices now' }));
    await waitFor(() => {
      expect(screen.queryByText('3 changes waiting for the price build')).toBeNull();
    });
  });

  it('shows prices with their SKU and tiers, and searches by SKU', async () => {
    const requests = mockApi({
      ...signedIn(['price_list.view']),
      ...detail,
      'GET /pricing/build': () => json(BUILT),
    });
    renderApp(`/price-lists/${LIST.id}`);
    expect(await screen.findByText('BRG-6205-2RS')).toBeTruthy();
    expect(screen.getByText('↳ tier')).toBeTruthy();
    expect(screen.getByText('₹410.00')).toBeTruthy();
    expect(screen.getByText(/assigned to Distributors/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe(
      `/admin/v1/pricing/price-lists/${LIST.id}/prices.csv`,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search prices'), 'brg-6205');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path.endsWith('/prices'))
          .at(-1)
          ?.query.get('q'),
      ).toBe('brg-6205');
    });
  });

  it('names refused import rows, then imports the valid ones', async () => {
    const requests = mockApi({
      ...signedIn(['price_list.view', 'price_list.manage']),
      ...detail,
      'GET /pricing/build': () => json(BUILT),
      [`POST /pricing/price-lists/${LIST.id}/prices/import`]: (request) =>
        request.query.get('skipInvalid') === 'true'
          ? json({
              added: 1,
              updated: 0,
              skipped: [{ row: 2, sku: 'NOPE', code: 'unknown_sku', message: 'No product' }],
            })
          : new Response(
              JSON.stringify({
                type: 'urn:muziris:problem:price_import_invalid_rows',
                title: 'Some rows are not valid prices; nothing was imported',
                status: 422,
                code: 'price_import_invalid_rows',
                rows: [{ row: 2, sku: 'NOPE', code: 'unknown_sku', message: 'No product' }],
              }),
              { status: 422, headers: { 'content-type': 'application/problem+json' } },
            ),
    });
    renderApp(`/price-lists/${LIST.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Import CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import prices' });
    const file = new File(
      ['sku,unit,min_quantity,price\nBRG-6205-2RS,each,1,450\nNOPE,each,1,1\n'],
      'prices.csv',
      {
        type: 'text/csv',
      },
    );
    await user.upload(within(dialog).getByLabelText('CSV file'), file);
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(
        false,
      );
    });
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByText(/Row 2: no product has this SKU/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Import the valid rows' }));
    expect(
      await screen.findByText(/Import finished: 1 added, 0 updated, 1 row skipped/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download skipped rows' })).toBeTruthy();
    const sent = requests.filter((r) => r.method === 'POST');
    expect(sent.map((r) => r.query.get('skipInvalid'))).toEqual([null, 'true']);
  });

  it('keeps delete disabled while the price list is assigned', async () => {
    mockApi({
      ...signedIn(['price_list.view', 'price_list.manage']),
      ...detail,
      'GET /pricing/build': () => json(BUILT),
      [`DELETE /pricing/price-lists/${LIST.id}`]: () =>
        problem(404, 'price_list_not_found', 'No such price list'),
    });
    renderApp(`/price-lists/${LIST.id}`);
    const button = await screen.findByRole('button', { name: 'Delete price list' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Remove its assignments before deleting it.')).toBeTruthy();
  });
});
