import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { quickOrderLines } from '../lib/checkout.js';
import type { ProductResult } from '../operations/generated.js';
import { data, mockApi, signedIn, renderApp, type MockRequest } from '../test/mock-api.js';

const PRODUCT: NonNullable<ProductResult['product']> = {
  id: 'p1',
  sku: 'CB-2.5',
  name: 'Copper cable 2.5 mm²',
  category: { id: 'hex', name: 'Hex bolts', parentId: 'bolts' },
  attributes: [
    { key: 'Conductor', values: ['Copper'] },
    { key: 'Colours', values: ['Red', 'Black'] },
  ],
  primaryUnit: { code: 'M', name: 'Metre', precision: 3 },
  units: [
    { code: 'M', name: 'Metre', precision: 3 },
    { code: 'ROLL', name: 'Roll', precision: 0 },
  ],
  price: {
    unitPrice: { amount: '42.00', currency: 'INR' },
    unitCode: 'M',
    quantity: '1',
    minQuantity: '1',
  },
};

function priceFor(request: MockRequest) {
  const v = request.variables ?? {};
  if (v['unitCode'] === 'ROLL') return data({ product: { id: 'p1', price: null } });
  if (v['quantity'] === '9999') {
    return data({ product: { id: 'p1', price: null } }, [
      {
        message: 'Order at most 5000 metres in one line.',
        path: ['product', 'price'],
        extensions: { code: 'BAD_USER_INPUT' },
      },
    ]);
  }
  return data({
    product: {
      id: 'p1',
      price: {
        unitPrice: { amount: '38.00', currency: 'INR' },
        unitCode: 'M',
        quantity: v['quantity'],
        minQuantity: '100',
      },
    },
  });
}

const LISTS = [
  {
    id: 'l1',
    name: 'Site A monthly',
    lineCount: 4,
    isOwn: true,
    updatedAt: '2026-11-01T10:00:00Z',
  },
  { id: 'l2', name: 'Spares', lineCount: 0, isOwn: true, updatedAt: '2026-10-20T10:00:00Z' },
];

function addLines(request: MockRequest) {
  const v = request.variables ?? {};
  if (v['listId'] === 'l2') {
    return data({
      addShoppingListLines: {
        list: null,
        refusal: {
          code: 'INVALID_LINES',
          message: 'Some lines cannot be added.',
          lines: [
            { index: 0, code: 'NOT_FOUND', message: 'This product is not available to you.' },
          ],
        },
      },
    });
  }
  const list = LISTS.find((l) => l.id === v['listId']) ?? { id: v['listId'], name: 'Site B' };
  return data({
    addShoppingListLines: { list: { id: list.id, name: list.name, lineCount: 1 }, refusal: null },
  });
}

function setup(product: ProductResult['product'] = PRODUCT, lists = LISTS) {
  const requests = mockApi({
    ...signedIn(),
    'GraphQL Product': () => data({ product }),
    'GraphQL ProductPrice': priceFor,
    'GraphQL ShoppingLists': () => data({ shoppingLists: { nodes: lists, nextAfter: null } }),
    'GraphQL CreateShoppingList': () =>
      data({
        createShoppingList: { list: { id: 'l3', name: 'Site B', lineCount: 0 }, refusal: null },
      }),
    'GraphQL AddShoppingListLines': addLines,
  });
  const view = renderApp(`/p/${encodeURIComponent(product?.sku ?? 'NOPE')}`);
  return { requests, ...view };
}

const priceBox = () =>
  screen
    .getByRole('heading', { name: 'Your price' })
    .closest<HTMLElement>('[aria-labelledby="price-title"]')!;

describe('the product page', () => {
  it('shows the details, the units and the loaded price without asking again', async () => {
    const { requests } = setup();
    expect(await screen.findByRole('heading', { name: 'Copper cable 2.5 mm²' })).toBeTruthy();
    expect(screen.getByText('Red, Black')).toBeTruthy();
    expect(screen.getByText('Metre (primary), Roll')).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(crumbs)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['All products', 'Fasteners', 'Bolts', 'Hex bolts']);
    expect(within(priceBox()).getByText('₹42.00')).toBeTruthy();
    expect(within(priceBox()).getByText('Kochi Traders')).toBeTruthy();
    expect(requests.some((r) => r.operationName === 'ProductPrice')).toBe(false);
  });

  it('asks for the price of a quantity once it fits the unit, with the line total', async () => {
    const { requests } = setup();
    const quantity = await screen.findByLabelText('Quantity');
    const user = userEvent.setup();
    await user.clear(quantity);
    await user.type(quantity, '250.5');
    expect(await within(priceBox()).findByText('₹38.00')).toBeTruthy();
    expect(within(priceBox()).getByText('Price for 100 or more.')).toBeTruthy();
    expect(within(priceBox()).getByText('₹9,519.00')).toBeTruthy();
    const asked = requests.filter((r) => r.operationName === 'ProductPrice');
    // Typing quickly asks once, for the last quantity.
    expect(asked.map((r) => r.variables)).toEqual([
      { sku: 'CB-2.5', unitCode: 'M', quantity: '250.5' },
    ]);
  });

  it('checks the quantity against the unit before asking', async () => {
    const { requests } = setup();
    const quantity = await screen.findByLabelText('Quantity');
    const user = userEvent.setup();
    await user.clear(quantity);
    await user.type(quantity, '1.2345');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Enter a number with at most 3 decimals, more than 0.',
    );
    expect(quantity.getAttribute('aria-invalid')).toBe('true');

    await user.selectOptions(screen.getByLabelText('Unit'), 'ROLL');
    expect(screen.getByLabelText<HTMLInputElement>('Quantity').value).toBe('1');
    await user.clear(quantity);
    await user.type(quantity, '2.5');
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number of roll, 1 or more.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nothing was asked: the roll quantity changed before the wait ended, then did not fit.
    expect(requests.filter((r) => r.operationName === 'ProductPrice')).toEqual([]);
  });

  it('shows the API’s refusal under the field', async () => {
    setup();
    const quantity = await screen.findByLabelText('Quantity');
    const user = userEvent.setup();
    await user.clear(quantity);
    await user.type(quantity, '9999');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Order at most 5000 metres in one line.',
    );
    expect(within(priceBox()).queryByText(/₹/)).toBeNull();
  });

  it('says Price on request when there is no price for the unit', async () => {
    setup();
    await userEvent.setup().selectOptions(await screen.findByLabelText('Unit'), 'ROLL');
    expect(await within(priceBox()).findByText('Price on request.')).toBeTruthy();
  });

  it('says so when the product is not one the buyer can see', async () => {
    setup(null);
    expect(await screen.findByRole('heading', { name: 'We can’t find that product' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Search products' })).toBeTruthy();
    });
  });
});

describe('ordering from the product page', () => {
  it('hands the unit and quantity to checkout as one line', async () => {
    const { router } = setup();
    const quantity = await screen.findByLabelText('Quantity');
    const user = userEvent.setup();
    await user.clear(quantity);
    await user.type(quantity, '250.5');
    await within(priceBox()).findByText('₹38.00');
    await user.click(within(priceBox()).getByRole('button', { name: 'Order now' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/checkout');
    });
    expect(quickOrderLines()).toEqual([{ productId: 'p1', unitCode: 'M', quantity: '250.5' }]);
  });

  it('cannot order without a price or a quantity that fits', async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Unit'), 'ROLL');
    await within(priceBox()).findByText('Price on request.');
    const order = within(priceBox()).getByRole<HTMLButtonElement>('button', { name: 'Order now' });
    expect(order.disabled).toBe(true);
    // A list still takes a line without a price.
    expect(
      within(priceBox()).getByRole<HTMLButtonElement>('button', { name: 'Add to shopping list' })
        .disabled,
    ).toBe(false);

    const quantity = screen.getByLabelText('Quantity');
    await user.clear(quantity);
    await user.type(quantity, '2.5');
    expect(order.disabled).toBe(true);
    expect(
      within(priceBox()).getByRole<HTMLButtonElement>('button', { name: 'Add to shopping list' })
        .disabled,
    ).toBe(true);
  });
});

describe('adding to a shopping list from the product page', () => {
  it('adds the line to the most recent list and links to it', async () => {
    const { requests } = setup();
    const user = userEvent.setup();
    await screen.findByLabelText('Quantity');
    await user.click(
      await within(priceBox()).findByRole('button', { name: 'Add to shopping list' }),
    );
    const status = await within(priceBox()).findByRole('status');
    expect(status.textContent).toBe('Added to Site A monthly. View list');
    expect(within(status).getByRole('link', { name: 'View list' }).getAttribute('href')).toBe(
      '/lists/l1',
    );
    expect(requests.find((r) => r.operationName === 'AddShoppingListLines')?.variables).toEqual({
      listId: 'l1',
      lines: [{ productId: 'p1', unitCode: 'M', quantity: '1' }],
    });
  });

  it('makes a new list with the name typed', async () => {
    const { requests } = setup(PRODUCT, []);
    const user = userEvent.setup();
    await screen.findByLabelText('Quantity');
    const add = await within(priceBox()).findByRole<HTMLButtonElement>('button', {
      name: 'Add to shopping list',
    });
    // With no lists yet, the picker starts on a new list, which needs a name.
    expect(add.disabled).toBe(true);
    await user.type(screen.getByLabelText('List name'), '  Site B ');
    await user.click(add);
    expect((await within(priceBox()).findByRole('status')).textContent).toContain(
      'Added to Site B.',
    );
    expect(requests.find((r) => r.operationName === 'CreateShoppingList')?.variables).toEqual({
      name: 'Site B',
    });
    expect(requests.find((r) => r.operationName === 'AddShoppingListLines')?.variables).toEqual({
      listId: 'l3',
      lines: [{ productId: 'p1', unitCode: 'M', quantity: '1' }],
    });
  });

  it('shows the refusal, and clears it when the quantity changes', async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Shopping list'), 'l2');
    await user.click(within(priceBox()).getByRole('button', { name: 'Add to shopping list' }));
    expect((await within(priceBox()).findByRole('alert')).textContent).toBe(
      'This product is not available to you.',
    );
    const quantity = screen.getByLabelText('Quantity');
    await user.clear(quantity);
    await user.type(quantity, '3');
    await waitFor(() => {
      expect(within(priceBox()).queryByText('This product is not available to you.')).toBeNull();
    });
    // The list picked stays picked.
    expect(screen.getByLabelText<HTMLSelectElement>('Shopping list').value).toBe('l2');
  });
});
