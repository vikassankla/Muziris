import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PREF_KEYS } from '../lib/prefs.js';
import {
  expectOnlyPreferencesStored,
  json,
  mockApi,
  problem,
  renderApp,
  signedIn,
  storedText,
} from '../test/mock-api.js';

const CUSTOMER_ID = '0b8f5a52-0000-4000-8000-000000000010';
const CUSTOMER = {
  id: CUSTOMER_ID,
  name: 'Kochi Industrial Supply',
  parentId: null,
  groupId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const empty = (key: string) => () => json({ [key]: [], nextAfter: null });

/** A customer detail page with nothing under it yet. */
function customerApi(permissions: string[]) {
  return {
    ...signedIn(permissions),
    [`GET /customers/${CUSTOMER_ID}`]: () => json({ customer: CUSTOMER }),
    [`GET /customers/${CUSTOMER_ID}/subsidiaries`]: empty('customers'),
    [`GET /customers/${CUSTOMER_ID}/buyer-users`]: empty('buyerUsers'),
    [`GET /customers/${CUSTOMER_ID}/invitations`]: empty('invitations'),
    [`GET /customers/${CUSTOMER_ID}/addresses`]: empty('addresses'),
    'GET /customers': () => json({ customers: [CUSTOMER], nextAfter: null }),
  };
}

describe('customer group form', () => {
  it('derives the code from the name and shows customer_group_code_taken under the code', async () => {
    const requests = mockApi({
      ...signedIn(['customer.view', 'customer.manage']),
      'POST /customers/groups': () =>
        problem(409, 'customer_group_code_taken', 'A customer group with this code already exists'),
    });
    renderApp('/customer-groups?new=true');
    const sheet = await screen.findByRole('dialog', { name: 'New customer group' });
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'Key accounts (West)' },
    });
    expect(within(sheet).getByLabelText<HTMLInputElement>('Code').value).toBe('key_accounts_west');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create customer group' }));

    expect(
      await within(sheet).findByText('This code is already used by another customer group.'),
    ).toBeTruthy();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      code: 'key_accounts_west',
      name: 'Key accounts (West)',
    });
  });

  it('refuses a code the API would refuse, before sending it', async () => {
    mockApi(signedIn(['customer.view', 'customer.manage']));
    renderApp('/customer-groups?new=true');
    const sheet = await screen.findByRole('dialog', { name: 'New customer group' });
    fireEvent.change(within(sheet).getByLabelText('Code'), { target: { value: 'key-accounts' } });
    expect(within(sheet).getByText(/Use 2 to 63 lowercase letters/)).toBeTruthy();
  });

  it('hides the create action from an admin without customer.manage', async () => {
    mockApi(signedIn(['customer.view']));
    renderApp('/customer-groups');
    await screen.findByRole('heading', { name: 'Customer groups' });
    expect(screen.queryByRole('button', { name: /New customer group/ })).toBeNull();
  });
});

describe('new customer', () => {
  it('creates the customer and opens it', async () => {
    const requests = mockApi({
      ...customerApi(['customer.view', 'customer.manage']),
      'POST /customers': () => json({ customer: CUSTOMER }, 201),
    });
    const { router } = renderApp('/customers?new=true');
    const sheet = await screen.findByRole('dialog', { name: 'New customer' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: CUSTOMER.name } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/customers/${CUSTOMER_ID}`);
    });
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      name: CUSTOMER.name,
      groupId: null,
      parentId: null,
    });
  });
});

describe('address form', () => {
  async function openAddressSheet() {
    renderApp(`/customers/${CUSTOMER_ID}?tab=addresses`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }));
    return screen.findByRole('dialog', { name: 'Add address' });
  }

  it('checks the PIN code before sending, and shows the API’s field errors', async () => {
    const requests = mockApi({
      ...customerApi(['customer.view', 'customer.manage']),
      [`POST /customers/${CUSTOMER_ID}/addresses`]: () =>
        problem(400, 'validation_failed', 'The request is not valid', {
          errors: [{ path: 'line1', message: 'Too small: expected string to have >=1 characters' }],
        }),
    });
    const sheet = await openAddressSheet();
    const fill = (label: string, value: string) => {
      fireEvent.change(within(sheet).getByLabelText(label), { target: { value } });
    };
    fill('Label', 'Chakan stores');
    fill('Street address', 'Gat No. 118');
    fill('City', 'Khed, Pune');
    fill('PIN code', '4105');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save address' }));

    expect(
      await within(sheet).findByText('Enter a 6-digit PIN code, such as 410501.'),
    ).toBeTruthy();
    expect(within(sheet).getByText('Choose a state.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('invitations', () => {
  it('shows the invitation token once, because emails are not built yet', async () => {
    mockApi({
      ...customerApi(['customer.view', 'customer.manage']),
      [`POST /customers/${CUSTOMER_ID}/invitations`]: () =>
        json(
          {
            invitation: {
              id: 'i1',
              customerId: CUSTOMER_ID,
              email: 'neha@example.in',
              displayName: 'Neha Shah',
              invitedByUserId: 'a',
              createdAt: '2026-10-28T00:00:00.000Z',
              expiresAt: '2026-11-04T00:00:00.000Z',
              acceptedAt: null,
              revokedAt: null,
            },
            token: 'tok_example_123',
          },
          201,
        ),
    });
    renderApp(`/customers/${CUSTOMER_ID}?tab=invitations&new=true`);
    const dialog = await screen.findByRole('dialog', { name: 'Invite a buyer user' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Neha Shah' } });
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'neha@example.in' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));

    const done = await screen.findByRole('dialog', { name: 'Invitation created' });
    expect(within(done).getByLabelText<HTMLInputElement>('Invitation token').value).toBe(
      'tok_example_123',
    );
    expectOnlyPreferencesStored();
    expect(storedText()).not.toContain('tok_example_123');
  });
});

const ROLE = {
  id: 'r1',
  code: 'sales_rep',
  name: 'Sales rep',
  description: 'Sees customers and the catalog',
  isBuiltIn: false,
  grantsAllPermissions: false,
  permissions: ['customer.view'],
};
const ADMINISTRATOR = {
  id: 'r0',
  code: 'administrator',
  name: 'Administrator',
  description: '',
  isBuiltIn: true,
  grantsAllPermissions: true,
  permissions: ['customer.view', 'setting.manage'],
};

function rolesApi(permissions: string[]) {
  return {
    ...signedIn(permissions),
    'GET /access/roles': () => json({ roles: [ADMINISTRATOR, ROLE] }),
    'GET /access/permissions': () =>
      json({
        permissions: [
          { key: 'customer.view', description: 'See customers' },
          { key: 'customer.manage', description: 'Create and edit customers' },
          { key: 'setting.manage', description: 'Change settings' },
        ],
      }),
  };
}

describe('admin role permission matrix', () => {
  it('locks permissions the admin does not hold, and saves the rest', async () => {
    const requests = mockApi({
      ...rolesApi(['admin_role.view', 'admin_role.manage', 'customer.view', 'customer.manage']),
      'PUT /access/roles/r1/permissions': () => new Response(null, { status: 204 }),
    });
    renderApp('/admin-roles/r1');
    await screen.findByRole('heading', { name: 'Sales rep' });

    expect(screen.getByRole('checkbox', { name: 'Manage Settings' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      screen.getByLabelText(/Manage Settings: You can only grant permissions you hold yourself/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Manage Customers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        permissions: ['customer.manage', 'customer.view'],
      });
    });
  });

  it('shows the built-in administrator as locked, with no save or delete', async () => {
    mockApi(rolesApi(['admin_role.view', 'admin_role.manage']));
    renderApp('/admin-roles/r0');
    await screen.findByRole('heading', { name: 'Administrator' });
    expect(
      screen.getByRole('checkbox', { name: 'View Customers' }).getAttribute('data-state'),
    ).toBe('checked');
    expect(screen.getByRole('checkbox', { name: 'View Customers' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete role/ })).toBeNull();
  });

  it('keeps the confirm dialog open and shows the refusal when a delete is refused', async () => {
    mockApi({
      ...rolesApi(['admin_role.view', 'admin_role.manage']),
      'DELETE /access/roles/r1': () =>
        problem(
          409,
          'last_administrator',
          'At least one admin user must keep the administrator role',
        ),
    });
    renderApp('/admin-roles/r1');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete role…' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete admin role' }));
    expect(
      await within(dialog).findByText('At least one admin user must keep the administrator role'),
    ).toBeTruthy();
  });
});

describe('app frame', () => {
  it('opens the command palette with Ctrl K, listing only what the admin may open', async () => {
    mockApi(signedIn(['customer.view', 'customer.manage']));
    renderApp('/');
    await screen.findByRole('heading', { name: /^Good/ });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const options = within(palette)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining([
        'Home',
        'Customers',
        'Customer groups',
        'New customer',
        'New customer group',
      ]),
    );
    expect(options).not.toContain('Products');
    expect(options).not.toContain('New product');
  });

  it('collapses the sidebar with Ctrl B', async () => {
    mockApi(signedIn(['customer.view']));
    renderApp('/');
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Customers' })).toBeTruthy();
  });

  it('switches to dark mode and remembers it for the next visit', async () => {
    mockApi(signedIn([]));
    const first = renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: /^Good/ });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.click(within(palette).getByRole('option', { name: 'Theme: Dark' }));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
    expect(localStorage.getItem(PREF_KEYS.theme)).toBe('dark');
    expectOnlyPreferencesStored();

    // A reload starts dark.
    first.unmount();
    document.documentElement.classList.remove('dark');
    renderApp('/');
    await screen.findByRole('heading', { name: /^Good/ });
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('remembers a collapsed sidebar', async () => {
    mockApi(signedIn(['customer.view']));
    const first = renderApp('/');
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await screen.findByRole('button', { name: 'Expand sidebar' });
    expect(localStorage.getItem(PREF_KEYS.sidebarCollapsed)).toBe('true');

    first.unmount();
    renderApp('/');
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('falls back to the defaults when browser storage is blocked', async () => {
    const blocked = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    mockApi(signedIn(['customer.view']));
    renderApp('/');
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    // The change still applies to this tab.
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('offers the theme in the user menu', async () => {
    mockApi(signedIn([]));
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Asha Rao/ }));
    expect(await screen.findByRole('menuitem', { name: /Theme/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });

  it('says the session ended when a live session expires', async () => {
    mockApi({});
    renderApp('/sign-in?reason=session_ended');
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeTruthy();
  });
});

describe('product detail', () => {
  const PRODUCT = {
    id: 'p1',
    sku: 'BRG-6204',
    name: 'Ball bearing 6204',
    type: 'simple',
    status: 'enabled',
    categoryId: null,
    attributes: { bore_mm: '20' },
    primaryUnitCode: 'each',
    units: [{ code: 'each', name: 'Each', precision: 0 }],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  it('saves only the fields that changed', async () => {
    let stored = PRODUCT;
    const requests = mockApi({
      ...signedIn(['product.view', 'product.manage']),
      'GET /catalog/products/p1': () => json({ product: stored }),
      'GET /catalog/categories': () => json({ categories: [] }),
      'GET /catalog/product-units': () => json({ productUnits: PRODUCT.units }),
      'PATCH /catalog/products/p1': () => {
        stored = {
          ...PRODUCT,
          name: 'Ball bearing 6204-2RS',
          updatedAt: '2026-10-02T00:00:00.000Z',
        };
        return json({ product: stored });
      },
    });
    renderApp('/products/p1');
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Ball bearing 6204-2RS' },
    });
    expect(await screen.findByText('Unsaved changes.')).toBeTruthy();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
        name: 'Ball bearing 6204-2RS',
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Unsaved changes.')).toBeNull();
    });
  });

  it('refuses a repeated attribute key before saving', async () => {
    mockApi({
      ...signedIn(['product.view', 'product.manage']),
      'GET /catalog/products/p1': () => json({ product: PRODUCT }),
      'GET /catalog/categories': () => json({ categories: [] }),
      'GET /catalog/product-units': () => json({ productUnits: PRODUCT.units }),
    });
    renderApp('/products/p1');
    fireEvent.click(await screen.findByRole('button', { name: 'Add attribute' }));
    const keys = screen.getAllByLabelText('Attribute key');
    fireEvent.change(keys[1]!, { target: { value: 'bore_mm' } });
    expect(await screen.findByText('Key "bore_mm" is already used on this product.')).toBeTruthy();
  });
});
