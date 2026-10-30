import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { REGISTRY_HASHES } from '../test/registry.js';
import { data, mockApi, problem, ROW, signedIn, renderApp } from '../test/mock-api.js';

const table = () => screen.getByRole('table', { name: 'Products' });

describe('browsing the catalogue', () => {
  it('lists products with the buyer’s price, in lakhs, and Price on request when there is none', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL Products': () =>
        data({
          products: {
            nodes: [
              {
                ...ROW,
                price: { unitPrice: { amount: '112500', currency: 'INR' }, unitCode: 'EA' },
              },
              { ...ROW, id: 'p2', sku: 'HB-M8-50', name: 'Hex bolt M8 × 50', price: null },
            ],
            nextAfter: null,
          },
        }),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'All products' })).toBeTruthy();
    const rows = within(table()).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('₹1,12,500.00')).toBeTruthy();
    expect(within(rows[2]!).getByText('Price on request')).toBeTruthy();
    expect(
      screen.getByText(/Prices are your prices for Kochi Traders, in INR, excluding GST/),
    ).toBeTruthy();
  });

  it('sends every operation as a GET with its hash and the website, never its text', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL Products': () => data({ products: { nodes: [ROW], nextAfter: null } }),
    });
    renderApp('/');
    await screen.findByRole('heading', { name: 'All products' });
    const graphql = requests.filter((r) => r.path === '/graphql');
    expect(graphql.map((r) => r.operationName)).toEqual(['Shell', 'Products']);
    for (const request of graphql) {
      expect(request.method).toBe('GET');
      expect(request.query.has('query')).toBe(false);
      expect(request.headers.get('Muziris-Website')).toBe('main');
      const extensions = JSON.parse(request.query.get('extensions') ?? '{}') as {
        persistedQuery: { version: number; sha256Hash: string };
      };
      expect(extensions.persistedQuery.version).toBe(1);
      expect(REGISTRY_HASHES).toContain(extensions.persistedQuery.sha256Hash);
    }
  });

  it('shows a category with its side menu and breadcrumb, including subcategories by default', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL Products': () => data({ products: { nodes: [ROW], nextAfter: 'HB-M8-40' } }),
    });
    const { router } = renderApp('/c/bolts');
    expect(await screen.findByRole('heading', { name: 'Bolts' })).toBeTruthy();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Fasteners' })).toBeTruthy();
    expect(within(breadcrumb).getByText('Bolts').getAttribute('aria-current')).toBe('page');
    const side = screen.getByRole('navigation', { name: 'Fasteners' });
    expect(within(side).getByRole('link', { name: 'Hex bolts' })).toBeTruthy();
    const bar = screen.getByRole('navigation', { name: 'Categories' });
    expect(within(bar).getByRole('link', { name: 'Fasteners' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(requests.at(-1)?.variables).toEqual({
      categoryId: 'bolts',
      includeSubcategories: true,
      first: 20,
      after: null,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Include subcategories' }));
    await screen.findByRole('heading', { name: 'Bolts' });
    expect(router.state.location.search).toEqual({ only: true });
    expect(requests.at(-1)?.variables).toMatchObject({ includeSubcategories: false });

    await user.click(screen.getByRole('link', { name: 'Next' }));
    await screen.findByRole('link', { name: 'First page' });
    expect(router.state.location.search).toEqual({ only: true, after: 'HB-M8-40' });
    expect(requests.at(-1)?.variables).toMatchObject({
      after: 'HB-M8-40',
      includeSubcategories: false,
    });
  });

  it('says so when a category has no products, or is not one the buyer can see', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL Products': () => data({ products: { nodes: [], nextAfter: null } }),
    });
    const { router } = renderApp('/c/tools');
    expect(await screen.findByRole('heading', { name: 'No products here yet' })).toBeTruthy();
    await router.navigate({ to: '/c/$categoryId', params: { categoryId: 'secret' } });
    expect(
      await screen.findByRole('heading', { name: 'We can’t find that category' }),
    ).toBeTruthy();
  });

  it('shows the fixed error and the reference when the API fails, and never the server’s words', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL Products': () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                message: 'relation "price" does not exist',
                extensions: { code: 'INTERNAL_ERROR' },
              },
            ],
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json', 'x-request-id': 'req-42' },
          },
        ),
    });
    renderApp('/');
    expect(await screen.findByText("We couldn't load this page")).toBeTruthy();
    expect(screen.getByText('Reference: req-42')).toBeTruthy();
    expect(screen.queryByText(/relation/)).toBeNull();
  });

  it('shows the not found page for an unknown address', async () => {
    mockApi({ ...signedIn(), 'GraphQL Products': () => problem(500, 'x', 'x') });
    renderApp('/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
