import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn, WEBSITES } from '../test/mock-api.js';

const INDIA = WEBSITES[0];

const TERM_DAYS = {
  key: 'payment.term_days',
  group: 'Payments',
  label: 'Payment term',
  description: 'Days a customer has to pay an order placed on payment terms',
  editor: { kind: 'integer', min: 0, max: 365, unit: 'days' },
  allowedScopes: ['customer', 'customer_group', 'website', 'organization', 'global'],
  defaultValue: 30,
  value: 45,
  source: 'website',
};
const FLAT_RATE = {
  key: 'shipping.flat_rate',
  group: 'Shipping',
  label: 'Flat shipping charge per order',
  description: 'Flat shipping charge per order, in the website currency',
  editor: { kind: 'money' },
  allowedScopes: ['website', 'organization', 'global'],
  defaultValue: { amount: '0' },
  value: { amount: '250.00' },
  source: 'default',
};

const sideData = {
  'GET /access/buyer-roles': () => json({ buyerRoles: [], nextAfter: null }),
};

describe('websites', () => {
  it('lists websites and creates one, with the country setting the currency', async () => {
    const requests = mockApi({
      ...signedIn(['website.view', 'website.manage']),
      'POST /websites': () =>
        json({ website: { ...WEBSITES[1], id: '7c1e0a11-0000-4000-8000-0000000000e3' } }, 201),
    });
    renderApp('/websites?new=true');
    const sheet = await screen.findByRole('dialog', { name: 'New website' });
    const user = userEvent.setup();
    await user.type(within(sheet).getByLabelText('Name'), 'Acme US');
    await user.type(within(sheet).getByLabelText(/^Code/), 'acme-us-2');
    await user.click(within(sheet).getByRole('combobox', { name: 'Country' }));
    await user.click(await screen.findByRole('option', { name: 'United States' }));
    expect(within(sheet).getByLabelText<HTMLInputElement>(/^Currency/).value).toBe('USD');
    expect(within(sheet).getByLabelText('How this website formats').textContent).toContain(
      '$1,234,567.50',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Create website' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        code: 'acme-us-2',
        name: 'Acme US',
        countryCode: 'US',
        defaultCurrency: 'USD',
        defaultLocale: 'en-US',
        timeZone: 'America/Chicago',
        unitSystem: 'imperial',
      });
    });
  });

  it('edits a website without sending its fixed fields', async () => {
    const requests = mockApi({
      ...signedIn(['website.view', 'website.manage']),
      [`PATCH /websites/${INDIA.id}`]: () => json({ website: { ...INDIA, isActive: false } }),
    });
    renderApp('/websites');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit India' }));
    const sheet = await screen.findByRole('dialog', { name: 'India' });
    expect(within(sheet).getByLabelText<HTMLInputElement>(/^Code/).readOnly).toBe(true);
    await user.click(within(sheet).getByRole('switch'));
    await user.click(within(sheet).getByRole('button', { name: 'Save website' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
        name: 'India',
        defaultLocale: 'en-IN',
        timeZone: 'Asia/Kolkata',
        unitSystem: 'metric',
        isActive: false,
      });
    });
  });

  it('shows the list without changes to an admin who may only look', async () => {
    mockApi(signedIn(['website.view']));
    renderApp('/websites');
    expect(await screen.findByText('acme-us')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New website' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit India' })).toBeNull();
  });
});

describe('settings', () => {
  it('starts from the top bar website and shows each value with its source', async () => {
    const requests = mockApi({
      ...signedIn(['setting.view']),
      ...sideData,
      'GET /settings': () => json({ settings: [TERM_DAYS, FLAT_RATE] }),
    });
    renderApp('/settings');
    // The page loads once without a website, then again for the top bar's: wait for that
    // second load before reading the cards, which are replaced when it lands.
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path === '/settings')
          .at(-1)
          ?.query.get('websiteId'),
      ).toBe(INDIA.id);
    });
    const term = await screen.findByRole('group', { name: 'Payment term' });
    expect(within(term).getByText('45 days')).toBeTruthy();
    expect(within(term).getByText('Website')).toBeTruthy();
    const rate = await screen.findByRole('group', { name: 'Flat shipping charge per order' });
    expect(within(rate).getByText('₹250.00')).toBeTruthy();
    expect(within(rate).getByText('Default')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('shows the feature toggles in their own section, and turns one off', async () => {
    const LISTS = {
      key: 'features.shopping_lists',
      group: 'Features',
      label: 'Shopping lists',
      description: 'Buyers can keep shopping lists and check out from them',
      editor: { kind: 'boolean' },
      allowedScopes: ['customer', 'customer_group', 'website', 'organization', 'global'],
      defaultValue: true,
      value: true,
      source: 'default',
    };
    const requests = mockApi({
      ...signedIn(['setting.view', 'setting.manage']),
      ...sideData,
      'GET /settings': () => json({ settings: [TERM_DAYS, LISTS] }),
      'PUT /settings/features.shopping_lists': () => json({}),
    });
    renderApp(`/settings?website=${INDIA.id}`);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Features' })).toBeTruthy();
    const lists = await screen.findByRole('group', { name: 'Shopping lists' });
    expect(within(lists).getByText('On')).toBeTruthy();
    await user.click(within(lists).getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shopping lists' });
    await user.click(within(dialog).getByRole('switch'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        scope: { type: 'website', id: INDIA.id },
        value: false,
      });
    });
  });

  it('overrides a setting at the website and clears an override', async () => {
    const requests = mockApi({
      ...signedIn(['setting.view', 'setting.manage']),
      ...sideData,
      'GET /settings': () => json({ settings: [TERM_DAYS, FLAT_RATE] }),
      'PUT /settings/shipping.flat_rate': () => json({}),
      'DELETE /settings/payment.term_days': () => new Response(null, { status: 204 }),
    });
    renderApp(`/settings?website=${INDIA.id}`);
    const user = userEvent.setup();
    const rate = await screen.findByRole('group', { name: 'Flat shipping charge per order' });
    await user.click(within(rate).getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Flat shipping charge per order' });
    const value = within(dialog).getByLabelText('Value');
    await user.clear(value);
    await user.type(value, '300');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        scope: { type: 'website', id: INDIA.id },
        value: { amount: '300' },
      });
    });

    const term = screen.getByRole('group', { name: 'Payment term' });
    await user.click(within(term).getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      const cleared = requests.find((r) => r.method === 'DELETE');
      expect(cleared?.query.get('scope')).toBe('website');
      expect(cleared?.query.get('scopeId')).toBe(INDIA.id);
    });
  });

  it('shows a stored amount the currency cannot hold, and still lets it be changed', async () => {
    mockApi({
      ...signedIn(['setting.view', 'setting.manage']),
      ...sideData,
      'GET /settings': () =>
        json({
          settings: [
            { ...TERM_DAYS },
            { ...FLAT_RATE, value: { amount: '150.555' }, source: 'website' },
          ],
        }),
    });
    renderApp(`/settings?website=${INDIA.id}`);
    const rate = await screen.findByRole('group', { name: 'Flat shipping charge per order' });
    expect(await within(rate).findByText('150.555 INR')).toBeTruthy();
    expect(within(rate).getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(within(rate).getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('warns when checkout cannot offer the payment methods listed', async () => {
    const warning =
      'Checkout refuses every order on India: none of these methods can be used there.';
    mockApi({
      ...signedIn(['setting.view']),
      ...sideData,
      'GET /settings': () =>
        json({
          settings: [
            {
              key: 'payment.methods',
              group: 'Payments',
              label: 'Payment methods',
              description: 'Payment methods checkout offers',
              editor: {
                kind: 'choices',
                multiple: true,
                options: [
                  { value: 'terms', label: 'On payment terms' },
                  { value: 'razorpay', label: 'Razorpay' },
                ],
              },
              allowedScopes: ['customer', 'customer_group', 'website', 'organization', 'global'],
              defaultValue: ['terms'],
              value: ['razorpay'],
              source: 'website',
              warnings: [warning, 'Razorpay is not offered: its keys are not set on the server.'],
            },
            TERM_DAYS,
          ],
        }),
    });
    renderApp(`/settings?website=${INDIA.id}`);
    const methods = await screen.findByRole('group', { name: 'Payment methods' });
    const alert = await within(methods).findByRole('alert');
    expect(within(alert).getByText(warning)).toBeTruthy();
    expect(
      within(alert).getByText('Razorpay is not offered: its keys are not set on the server.'),
    ).toBeTruthy();
    const term = screen.getByRole('group', { name: 'Payment term' });
    expect(within(term).queryByRole('alert')).toBeNull();
  });

  it('shows a refused value in the dialog', async () => {
    mockApi({
      ...signedIn(['setting.view', 'setting.manage']),
      ...sideData,
      'GET /settings': () => json({ settings: [TERM_DAYS] }),
      'PUT /settings/payment.term_days': () =>
        problem(422, 'setting_scope_not_allowed', 'This setting cannot be set at that scope'),
    });
    renderApp(`/settings?website=${INDIA.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Payment term' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('This setting cannot be set at that scope'),
    ).toBeTruthy();
  });
});
