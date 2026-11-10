import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ShoppingListResult } from '../operations/generated.js';
import { data, mockApi, renderApp, signedIn, type MockRequest } from '../test/mock-api.js';

const inr = (amount: string) => ({ amount, currency: 'INR' });

const LIST: NonNullable<ShoppingListResult['shoppingList']> = {
  id: 'l1',
  name: 'Monthly maintenance',
  lineCount: 2,
  isOwn: true,
  updatedAt: '2026-10-26T08:35:00.000Z',
  lines: {
    nodes: [
      {
        id: 'ln1',
        position: 1,
        productId: 'p1',
        unitCode: 'EA',
        quantity: '400',
        note: null,
        product: {
          id: 'p1',
          sku: 'HB-M8-40',
          name: 'Hex bolt M8 × 40, zinc plated',
          units: [{ code: 'EA', name: 'Each', precision: 0 }],
        },
        price: { unitPrice: inr('12.50'), minQuantity: '1' },
      },
      {
        id: 'ln2',
        position: 2,
        productId: 'p2',
        unitCode: 'EA',
        quantity: '200',
        note: null,
        product: {
          id: 'p2',
          sku: 'WA-M8',
          name: 'Flat washer M8',
          units: [{ code: 'EA', name: 'Each', precision: 0 }],
        },
        price: { unitPrice: inr('1.20'), minQuantity: '1' },
      },
    ],
    nextAfter: null,
  },
};

const LISTS = {
  shoppingLists: {
    nodes: [
      { id: 'l1', name: 'Monthly maintenance', lineCount: 2, isOwn: true, updatedAt: '' },
      { id: 'l2', name: 'Site B', lineCount: 4, isOwn: true, updatedAt: '' },
    ],
    nextAfter: null,
  },
};

const byOperation = (requests: MockRequest[], name: string) =>
  requests.filter((r) => r.operationName === name);

function handlers(move: (request: MockRequest) => Response) {
  return {
    ...signedIn(),
    'GraphQL ShoppingList': () => data({ shoppingList: LIST }),
    'GraphQL ShoppingLists': () => data(LISTS),
    'GraphQL MoveShoppingListLines': move,
  };
}

const moved = () =>
  data({
    moveShoppingListLines: { list: { id: 'l2', name: 'Site B', lineCount: 5 }, refusal: null },
  });

describe('moving lines between lists', () => {
  it('moves the selected lines to another of the buyer’s lists', async () => {
    const requests = mockApi(handlers(moved));
    renderApp('/lists/l1');
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();

    await user.click(
      await screen.findByRole('checkbox', { name: 'Select Hex bolt M8 × 40, zinc plated' }),
    );
    const target = await screen.findByRole('combobox', { name: 'Move to' });
    // The list being shown is not offered as a target.
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Site B', 'New list…']);
    await user.click(screen.getByRole('button', { name: 'Move 1 line' }));

    await waitFor(() => {
      expect(byOperation(requests, 'MoveShoppingListLines')[0]?.variables).toEqual({
        fromListId: 'l1',
        toListId: 'l2',
        lineIds: ['ln1'],
      });
    });
    expect(await screen.findByText('Moved 1 line to Site B.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Site B' }).getAttribute('href')).toBe(
      '/lists/l2',
    );
    // The list reloads without the moved line, and nothing stays selected.
    await waitFor(() => {
      expect(byOperation(requests, 'ShoppingList')).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
  });

  it('moves every line when all are selected', async () => {
    const requests = mockApi(handlers(moved));
    renderApp('/lists/l1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select all lines' }));
    await user.click(await screen.findByRole('button', { name: 'Move 2 lines' }));
    await waitFor(() => {
      expect(byOperation(requests, 'MoveShoppingListLines')[0]?.variables).toMatchObject({
        lineIds: ['ln1', 'ln2'],
      });
    });
  });

  it('makes a new list to move to', async () => {
    const requests = mockApi({
      ...handlers(moved),
      'GraphQL CreateShoppingList': () =>
        data({
          createShoppingList: { list: { id: 'l3', name: 'Site C', lineCount: 0 }, refusal: null },
        }),
    });
    renderApp('/lists/l1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Flat washer M8' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Move to' }), 'new');
    const move = screen.getByRole('button', { name: 'Move 1 line' });
    expect((move as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('List name'), 'Site C');
    await user.click(move);
    await waitFor(() => {
      expect(byOperation(requests, 'MoveShoppingListLines')[0]?.variables).toEqual({
        fromListId: 'l1',
        toListId: 'l3',
        lineIds: ['ln2'],
      });
    });
    expect(byOperation(requests, 'CreateShoppingList')[0]?.variables).toEqual({ name: 'Site C' });
  });

  it('shows a refused move and keeps the selection', async () => {
    mockApi(
      handlers(() =>
        data({
          moveShoppingListLines: {
            list: null,
            refusal: { code: 'not_allowed', message: 'You may not change that list.', lines: [] },
          },
        }),
      ),
    );
    renderApp('/lists/l1');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Select Hex bolt M8 × 40, zinc plated' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Move 1 line' }));
    expect(await screen.findByText('You may not change that list.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move 1 line' })).toBeTruthy();
  });
});
