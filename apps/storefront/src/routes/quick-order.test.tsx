import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { data, mockApi, renderApp, ROW, signedIn, type MockRequest } from '../test/mock-api.js';

const hit = (sku: string, name: string) => ({
  match: 'TEXT',
  product: { ...ROW, id: sku, sku, name },
});

function search(request: MockRequest) {
  const query = request.variables?.['query'];
  return data({
    search: {
      nodes:
        query === 'zzz'
          ? []
          : [hit('HB-M8-40', 'Hex bolt M8 × 40, zinc plated'), hit('HB-M8-60', 'Hex bolt M8 × 60')],
      nextOffset: null,
    },
  });
}

const handlers = {
  ...signedIn(),
  'GraphQL ShoppingLists': () => data({ shoppingLists: { nodes: [], nextAfter: null } }),
  'GraphQL Search': search,
};

const searches = (requests: MockRequest[]) => requests.filter((r) => r.operationName === 'Search');

describe('quick order typeahead', () => {
  it('finds a product by name or SKU and adds it as a line', async () => {
    const requests = mockApi(handlers);
    renderApp('/quick-order');
    const user = userEvent.setup();
    const find = await screen.findByRole('combobox', { name: 'Find a product' });
    const items = screen.getByLabelText<HTMLTextAreaElement>('Items');
    await user.type(items, 'WA-M8, 200');

    await user.type(find, 'hex bolt');
    const option = await screen.findByRole('option', { name: /HB-M8-60/ });
    expect(searches(requests).at(-1)?.variables).toEqual({ query: 'hex bolt', first: 8 });
    await user.click(option);

    expect(items.value).toBe('WA-M8, 200\nHB-M8-60, 1');
    expect(find).toHaveProperty('value', '');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks with the keyboard', async () => {
    mockApi(handlers);
    renderApp('/quick-order');
    const user = userEvent.setup();
    const find = await screen.findByRole('combobox', { name: 'Find a product' });
    await user.type(find, 'hex');
    await screen.findByRole('option', { name: /HB-M8-40/ });
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Items').value).toBe('HB-M8-60, 1');
  });

  it('waits for two characters and says when nothing matched', async () => {
    const requests = mockApi(handlers);
    renderApp('/quick-order');
    const user = userEvent.setup();
    const find = await screen.findByRole('combobox', { name: 'Find a product' });
    await user.type(find, 'z');
    // Longer than the pause before a search, so a search would have been sent.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searches(requests)).toHaveLength(0);
    await user.type(find, 'zz');
    expect(await screen.findByText('No products match “zzz”.')).toBeTruthy();
    await waitFor(() => {
      expect(searches(requests)).toHaveLength(1);
    });
  });
});
