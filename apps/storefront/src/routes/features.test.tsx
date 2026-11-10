import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { data, mockApi, renderApp, signedIn, type MockRequest } from '../test/mock-api.js';

// Feature toggles (ADR 0031): the API refuses a feature that is off; the app hides its links and
// buttons, and a page reached by its address says so instead of failing.

const PRODUCT = {
  id: 'p1',
  sku: 'HB-M8-40',
  name: 'Hex bolt M8 × 40, zinc plated',
  category: { id: 'hex', name: 'Hex bolts', parentId: 'bolts' },
  attributes: [],
  primaryUnit: { code: 'EA', name: 'Each', precision: 0 },
  units: [{ code: 'EA', name: 'Each', precision: 0 }],
  price: {
    unitPrice: { amount: '12.50', currency: 'INR' },
    unitCode: 'EA',
    quantity: '1',
    minQuantity: '1',
  },
};

const lists = () => data({ shoppingLists: { nodes: [], nextAfter: null } });
const listCalls = (requests: MockRequest[]) =>
  requests.filter((r) => r.operationName?.includes('ShoppingList'));

async function header() {
  return within(await screen.findByRole('banner'));
}

describe('feature toggles', () => {
  it('shows quick order and lists when they are on', async () => {
    mockApi({ ...signedIn(), 'GraphQL ShoppingLists': lists });
    renderApp('/lists');
    const bar = await header();
    expect(bar.getByRole('link', { name: 'Quick order' })).toBeTruthy();
    expect(bar.getByRole('link', { name: 'Lists' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Shopping lists' })).toBeTruthy();
  });

  it('hides shopping lists when they are off, and says so at their address', async () => {
    const requests = mockApi({
      ...signedIn({ shoppingLists: false }),
      'GraphQL ShoppingLists': lists,
    });
    renderApp('/lists');
    expect(await screen.findByText("This isn't available on your account")).toBeTruthy();
    const bar = await header();
    expect(bar.queryByRole('link', { name: 'Lists' })).toBeNull();
    expect(bar.getByRole('link', { name: 'Quick order' })).toBeTruthy();
    expect(listCalls(requests)).toEqual([]);
  });

  it('says a list is not available when lists are off', async () => {
    const requests = mockApi(signedIn({ shoppingLists: false }));
    renderApp('/lists/l1');
    expect(await screen.findByText("This isn't available on your account")).toBeTruthy();
    expect(listCalls(requests)).toEqual([]);
  });

  it('leaves out adding to a list on a product while lists are off', async () => {
    const requests = mockApi({
      ...signedIn({ shoppingLists: false }),
      'GraphQL Product': () => data({ product: PRODUCT }),
      'GraphQL ProductPrice': () => data({ product: { id: 'p1', price: PRODUCT.price } }),
    });
    renderApp('/p/HB-M8-40');
    expect(await screen.findByRole('button', { name: /Order now/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to shopping list' })).toBeNull();
    expect(listCalls(requests)).toEqual([]);
  });

  it('hides quick order when it is off, and says so at its address', async () => {
    mockApi({ ...signedIn({ quickOrder: false }), 'GraphQL ShoppingLists': lists });
    renderApp('/quick-order');
    expect(await screen.findByText("This isn't available on your account")).toBeTruthy();
    const bar = await header();
    expect(bar.queryByRole('link', { name: 'Quick order' })).toBeNull();
    expect(bar.getByRole('link', { name: 'Lists' })).toBeTruthy();
  });

  it('leaves out the CSV upload when it is off, and pasting stays', async () => {
    mockApi({ ...signedIn({ quickOrderCsv: false }), 'GraphQL ShoppingLists': lists });
    renderApp('/quick-order');
    expect(await screen.findByLabelText('Items')).toBeTruthy();
    expect(screen.queryByText('Or upload a CSV')).toBeNull();
    expect(screen.getByText(/^Paste SKUs and quantities, then/)).toBeTruthy();
  });

  it('runs quick order without lists while lists are off', async () => {
    const requests = mockApi(signedIn({ shoppingLists: false }));
    renderApp('/quick-order');
    expect(await screen.findByLabelText('Items')).toBeTruthy();
    expect(listCalls(requests)).toEqual([]);
  });

  it('does not check out from a list while lists are off', async () => {
    const requests = mockApi(signedIn({ shoppingLists: false }));
    renderApp('/checkout?list=l1');
    expect(await screen.findByText("This isn't available on your account")).toBeTruthy();
    expect(listCalls(requests)).toEqual([]);
  });
});
