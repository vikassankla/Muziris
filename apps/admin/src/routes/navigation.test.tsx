import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn } from '../test/mock-api.js';

function navLinks(): string[] {
  const nav = screen.getByRole('navigation', { name: 'Main' });
  return within(nav)
    .queryAllByRole('link')
    .map((link) => link.textContent);
}

describe('permission-aware navigation', () => {
  it.each([
    [[], []],
    [['customer.view'], ['Customers']],
    [['product.view'], ['Products', 'Categories']],
    [
      ['buyer_role.view', 'admin_role.view'],
      ['Buyer roles', 'Admin roles'],
    ],
    [['customer.manage', 'order.view'], []],
    [
      ['admin_role.view', 'buyer_role.view', 'customer.view', 'product.view'],
      ['Customers', 'Buyer roles', 'Products', 'Categories', 'Admin roles'],
    ],
  ])('with %j shows %j', async (permissions, expected) => {
    mockApi(signedIn(permissions));
    renderApp('/');
    await screen.findByRole('heading', { name: /^Welcome/ });
    expect(navLinks()).toEqual(expected);
  });

  it('tells an admin with no screens to ask for access', async () => {
    mockApi(signedIn([]));
    renderApp('/');
    expect(
      await screen.findByText(/Your admin roles do not include any of these screens/),
    ).toBeTruthy();
  });

  it('shows "No access" when the API refuses, even for a screen hidden from the navigation', async () => {
    mockApi({
      ...signedIn([]),
      'GET /access/roles': () =>
        problem(403, 'permission_denied', 'You do not have permission to do this'),
    });
    renderApp('/admin-roles');
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(screen.getByText(/Ask an administrator if you need it/)).toBeTruthy();
    // The layout stays, so the admin can go elsewhere or sign out.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('shows "No access" when the navigation was stale and the API now refuses', async () => {
    mockApi({
      ...signedIn(['customer.view']),
      'GET /customers': () =>
        problem(403, 'permission_denied', 'You do not have permission to do this'),
    });
    renderApp('/customers');
    expect(await screen.findByText('No access')).toBeTruthy();
  });

  it('shows the title of other problems and never a 500’s detail', async () => {
    mockApi({
      ...signedIn(['product.view']),
      'GET /catalog/categories': () =>
        problem(500, 'internal_error', 'Database exploded at pg_stat 0xdead', {
          detail: 'relation "catalog_category" does not exist',
          requestId: 'req-12345678',
        }),
    });
    renderApp('/categories');
    expect(await screen.findByText('Something went wrong on our side')).toBeTruthy();
    expect(screen.getByText('Reference: req-12345678')).toBeTruthy();
    expect(screen.queryByText(/exploded|does not exist/)).toBeNull();
  });

  it('branches on code: a 404 shows the API’s title', async () => {
    mockApi({
      ...signedIn(['customer.view']),
      'GET /customers/0b8f5a52-0000-4000-8000-000000000099': () =>
        problem(404, 'customer_not_found', 'No such customer'),
      'GET /customers/0b8f5a52-0000-4000-8000-000000000099/subsidiaries': () =>
        problem(404, 'customer_not_found', 'No such customer'),
    });
    renderApp('/customers/0b8f5a52-0000-4000-8000-000000000099');
    expect(await screen.findByText('No such customer')).toBeTruthy();
  });

  it('lists products with paging', async () => {
    const requests = mockApi({
      ...signedIn(['product.view']),
      'GET /catalog/products': () =>
        json({
          products: [
            {
              id: 'p1',
              sku: 'BRG-6204',
              name: 'Ball bearing 6204',
              type: 'simple',
              status: 'enabled',
              categoryId: null,
              primaryUnitCode: 'each',
              units: [{ code: 'each', name: 'Each', precision: 0 }],
              attributes: {},
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
          nextAfter: 'BRG-6204',
        }),
    });
    renderApp('/products?after=BRG-6000');
    expect(await screen.findByText('Ball bearing 6204')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      '/products?after=BRG-6204',
    );
    const list = requests.find((r) => r.path === '/catalog/products');
    expect(list?.query.get('after')).toBe('BRG-6000');
    expect(list?.query.get('limit')).toBe('25');
  });
});
