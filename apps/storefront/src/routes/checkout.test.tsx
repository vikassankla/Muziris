import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetQuickOrder } from '../lib/checkout.js';
import type {
  CheckoutPreviewResult,
  ShoppingListResult,
  CheckoutAddressesResult,
} from '../operations/generated.js';
import { data, json, mockApi, renderApp, signedIn, type MockRequest } from '../test/mock-api.js';

const inr = (amount: string) => ({ amount, currency: 'INR' });

const ADDRESSES: CheckoutAddressesResult = {
  viewer: {
    customer: {
      addresses: [
        {
          id: 'a1',
          label: 'Kochi works',
          countryCode: 'IN',
          line1: 'Plot 12, Kakkanad',
          line2: null,
          city: 'Kochi',
          regionCode: '32',
          postalCode: '682030',
          gstin: '32AAPFU0939F1ZX',
          isDefaultBilling: false,
          isDefaultShipping: true,
        },
        {
          id: 'a2',
          label: 'Head office',
          countryCode: 'IN',
          line1: 'MG Road',
          line2: null,
          city: 'Kochi',
          regionCode: '32',
          postalCode: '682016',
          gstin: '32AAPFU0939F1ZX',
          isDefaultBilling: true,
          isDefaultShipping: false,
        },
      ],
    },
  },
};

const BOLT = {
  id: 'p1',
  sku: 'HB-M8-40',
  name: 'Hex bolt M8 × 40, zinc plated',
  units: [{ code: 'EA', name: 'Each', precision: 0 }],
};

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
        note: 'For the press line',
        product: BOLT,
        price: { unitPrice: inr('12.50'), minQuantity: '1' },
      },
      {
        id: 'ln2',
        position: 2,
        productId: 'p9',
        unitCode: 'EA',
        quantity: '3',
        note: null,
        product: null,
        price: null,
      },
    ],
    nextAfter: null,
  },
};

const PREVIEW: NonNullable<CheckoutPreviewResult['checkoutPreview']['preview']> = {
  totals: {
    currency: 'INR',
    lines: [
      {
        lineNo: 1,
        sku: 'HB-M8-40',
        productName: BOLT.name,
        unitName: 'Each',
        quantity: '400',
        unitPrice: inr('12.50'),
        discount: inr('0.00'),
        net: inr('5000.00'),
      },
    ],
    taxes: [{ lineNo: 1, name: 'IGST', rate: '0.18', amount: inr('900.00') }],
    shippingMethod: 'Flat rate',
    subtotal: inr('5000.00'),
    discount: inr('0.00'),
    shipping: inr('0.00'),
    shippingDiscount: inr('0.00'),
    tax: inr('900.00'),
    grandTotal: inr('5900.00'),
  },
  paymentTermDays: 30,
  dueOn: '2026-11-25',
};

const preview = () => data({ checkoutPreview: { preview: PREVIEW, refusal: null } });
const placed = () =>
  data({ placeOrder: { order: { number: 'MZ-000043' }, replayed: false, refusal: null } });

afterEach(() => {
  forgetQuickOrder();
});

const byOperation = (requests: MockRequest[], name: string) =>
  requests.filter((r) => r.operationName === name);

describe('shopping lists', () => {
  it('lists the buyer’s lists and makes a new one with a POSTed mutation', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL ShoppingLists': () =>
        data({
          shoppingLists: {
            nodes: [{ ...LIST, lines: undefined }],
            nextAfter: null,
          },
        }),
      'GraphQL CreateShoppingList': () =>
        data({
          createShoppingList: {
            list: { id: 'l2', name: 'Site visit', lineCount: 0 },
            refusal: null,
          },
        }),
      'GraphQL ShoppingList': () =>
        data({
          shoppingList: {
            ...LIST,
            id: 'l2',
            name: 'Site visit',
            lineCount: 0,
            lines: { nodes: [], nextAfter: null },
          },
        }),
    });
    const { router } = renderApp('/lists');
    const row = (await screen.findByRole('link', { name: 'Monthly maintenance' })).closest('tr')!;
    expect(within(row).getByText('2')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('New list'), 'Site visit');
    await userEvent.click(screen.getByRole('button', { name: 'Make list' }));
    expect(await screen.findByRole('heading', { name: 'Site visit' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/lists/l2');

    const [create] = byOperation(requests, 'CreateShoppingList');
    expect(create?.method).toBe('POST');
    expect(create?.variables).toEqual({ name: 'Site visit' });
    expect(create?.body).toMatchObject({
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        },
      },
    });
    expect(JSON.stringify(create?.body)).not.toContain('mutation');
  });

  it('shows a list’s lines at today’s price, marks a hidden product, and removes a line', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL ShoppingList': () => data({ shoppingList: LIST }),
      'GraphQL RemoveShoppingListLines': () =>
        data({
          removeShoppingListLines: {
            list: { id: 'l1', name: LIST.name, lineCount: 1 },
            refusal: null,
          },
        }),
    });
    renderApp('/lists/l1');
    const row = (await screen.findByRole('link', { name: BOLT.name })).closest('tr')!;
    expect(within(row).getByText('₹12.50')).toBeTruthy();
    expect(within(row).getByText('₹5,000.00')).toBeTruthy();
    expect(within(row).getByText('For the press line')).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(byOperation(requests, 'ShoppingList')).toHaveLength(2);
    });
    expect(byOperation(requests, 'RemoveShoppingListLines')[0]?.variables).toEqual({
      listId: 'l1',
      lineIds: ['ln1'],
    });
  });

  it('shows a refused change’s message', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL ShoppingList': () => data({ shoppingList: LIST }),
      'GraphQL UpdateShoppingListLine': () =>
        data({
          updateShoppingListLine: {
            list: null,
            refusal: { code: 'NOT_ALLOWED', message: 'You may not change this list.', lines: [] },
          },
        }),
    });
    renderApp('/lists/l1');
    const quantity = await screen.findByLabelText(`Quantity of ${BOLT.name}`);
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '500');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('You may not change this list.')).toBeTruthy();
  });
});

describe('quick order', () => {
  it('checks pasted rows, explains the problems and takes the good ones to checkout', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL ShoppingLists': () => data({ shoppingLists: { nodes: [], nextAfter: null } }),
      'GraphQL ProductsBySkus': () =>
        data({
          productsBySkus: {
            products: [{ ...BOLT, price: { unitPrice: inr('12.50') } }],
            missingSkus: ['NOPE-1'],
          },
        }),
      'GraphQL CheckoutAddresses': () => data(ADDRESSES),
      'GraphQL CheckoutPreview': preview,
      'GraphQL PlaceOrder': placed,
      'GraphQL Order': () => data({ order: null }),
    });
    const { router } = renderApp('/quick-order');
    const box = await screen.findByLabelText('Items');
    await userEvent.click(box);
    await userEvent.paste('hb-m8-40, 400\nNOPE-1 2\nHB-M8-40 1.5');
    await userEvent.click(screen.getByRole('button', { name: 'Check items' }));

    expect(await screen.findByText('1 ready, 2 with problems left out')).toBeTruthy();
    expect(screen.getByText('We can’t find this SKU in your catalogue.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number of each, 1 or more.')).toBeTruthy();
    expect(byOperation(requests, 'ProductsBySkus')[0]?.variables).toEqual({
      skus: ['hb-m8-40', 'NOPE-1'],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Go to checkout' }));
    expect(await screen.findByRole('button', { name: 'Place order · ₹5,900.00' })).toBeTruthy();
    const [first] = byOperation(requests, 'CheckoutPreview');
    expect(first?.variables).toEqual({
      input: {
        lines: [{ productId: 'p1', unitCode: 'EA', quantity: '400' }],
        billingAddressId: 'a2',
        shippingAddressId: 'a1',
      },
    });
    expect(screen.getByText('IGST 18%').nextSibling?.textContent).toBe('₹900.00');

    await userEvent.click(screen.getByRole('button', { name: 'Place order · ₹5,900.00' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/orders/MZ-000043');
    });
    const [place] = byOperation(requests, 'PlaceOrder');
    expect(place?.method).toBe('POST');
    expect(place?.variables).toMatchObject({
      input: { expectedGrandTotal: '5900.00', billingAddressId: 'a2', shippingAddressId: 'a1' },
    });
  });

  it('adds checked rows to a new shopping list', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL ShoppingLists': () => data({ shoppingLists: { nodes: [], nextAfter: null } }),
      'GraphQL ProductsBySkus': () =>
        data({
          productsBySkus: {
            products: [
              { ...BOLT, price: null },
              { ...BOLT, id: 'p2', sku: 'WA-M8', price: { unitPrice: inr('2.00') } },
            ],
            missingSkus: [],
          },
        }),
      'GraphQL CreateShoppingList': () =>
        data({
          createShoppingList: { list: { id: 'l9', name: 'Spares', lineCount: 0 }, refusal: null },
        }),
      'GraphQL AddShoppingListLines': () =>
        data({
          addShoppingListLines: { list: { id: 'l9', name: 'Spares', lineCount: 1 }, refusal: null },
        }),
      'GraphQL ShoppingList': () => data({ shoppingList: { ...LIST, id: 'l9', name: 'Spares' } }),
    });
    renderApp('/quick-order');
    await userEvent.click(await screen.findByLabelText('Items'));
    await userEvent.paste('HB-M8-40 10\nWA-M8 200');
    await userEvent.click(screen.getByRole('button', { name: 'Check items' }));
    expect(
      await screen.findByText('No price on your account. Ask your account manager for a quote.'),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText('List name'), 'Spares');
    await userEvent.click(screen.getByRole('button', { name: 'Add to shopping list' }));
    expect(await screen.findByRole('heading', { name: 'Spares' })).toBeTruthy();
    expect(byOperation(requests, 'AddShoppingListLines')[0]?.variables).toEqual({
      listId: 'l9',
      lines: [{ productId: 'p2', unitCode: 'EA', quantity: '200' }],
    });
  });
});

describe('checkout', () => {
  it('sends a reloaded quick order back to quick order', async () => {
    mockApi({ ...signedIn(), 'GraphQL CheckoutAddresses': () => data(ADDRESSES) });
    renderApp('/checkout');
    expect(await screen.findByText('Nothing to check out')).toBeTruthy();
  });

  it('checks out a list without its unavailable lines, and offers to empty it after', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL CheckoutAddresses': () => data(ADDRESSES),
      'GraphQL ShoppingList': () => data({ shoppingList: LIST }),
      'GraphQL CheckoutPreview': preview,
      'GraphQL PlaceOrder': placed,
      'GraphQL Order': () => data({ order: null }),
      'GraphQL RemoveShoppingListLines': () =>
        data({
          removeShoppingListLines: {
            list: { id: 'l1', name: LIST.name, lineCount: 0 },
            refusal: null,
          },
        }),
    });
    const { router } = renderApp('/checkout?list=l1');
    expect(await screen.findByText(/1 line is no longer available and left out/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Your PO number (optional)'), 'KT-PO-119');
    const button = await screen.findByRole('button', { name: 'Place order · ₹5,900.00' });
    await waitFor(() => {
      expect(byOperation(requests, 'CheckoutPreview').at(-1)?.variables).toMatchObject({
        input: { purchaseOrderNumber: 'KT-PO-119' },
      });
    });
    expect(byOperation(requests, 'CheckoutPreview').at(-1)?.variables).toMatchObject({
      input: { lines: [{ productId: 'p1', unitCode: 'EA', quantity: '400' }] },
    });
    await userEvent.click(button);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/orders/MZ-000043');
    });
    expect(router.state.location.search).toEqual({ fromList: 'l1' });
  });

  it('shows a refusal, and sends the same key again when a placing answer is lost', async () => {
    let attempts = 0;
    const requests = mockApi({
      ...signedIn(),
      'GraphQL CheckoutAddresses': () => data(ADDRESSES),
      'GraphQL ShoppingList': () => data({ shoppingList: LIST }),
      'GraphQL CheckoutPreview': preview,
      'GraphQL PlaceOrder': () => {
        attempts += 1;
        if (attempts === 1) return json({}, 503);
        if (attempts === 2) {
          return data({
            placeOrder: {
              order: null,
              replayed: false,
              refusal: {
                code: 'PRICES_CHANGED',
                message: 'Prices changed since you looked. Check the new total.',
                lines: [],
                taxProblems: [],
              },
            },
          });
        }
        return placed();
      },
      'GraphQL Order': () => data({ order: null }),
    });
    renderApp('/checkout?list=l1');
    const button = await screen.findByRole('button', { name: 'Place order · ₹5,900.00' });
    await userEvent.click(button);
    expect(await screen.findByText("We couldn't load this page")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Place order · ₹5,900.00' }));
    expect(
      await screen.findByText('Prices changed since you looked. Check the new total.'),
    ).toBeTruthy();
    const keys = byOperation(requests, 'PlaceOrder').map(
      (r) => (r.variables?.['input'] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    // The refusal re-runs the preview, and the next attempt gets a new key.
    await waitFor(() => {
      expect(byOperation(requests, 'CheckoutPreview').length).toBeGreaterThanOrEqual(2);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Place order · ₹5,900.00' }));
    await waitFor(() => {
      expect(byOperation(requests, 'PlaceOrder')).toHaveLength(3);
    });
    const third = byOperation(requests, 'PlaceOrder')[2]?.variables?.['input'] as {
      idempotencyKey: string;
    };
    expect(third.idempotencyKey).not.toBe(keys[0]);
  });

  it('shows why the preview refuses, line by line', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL CheckoutAddresses': () => data(ADDRESSES),
      'GraphQL ShoppingList': () => data({ shoppingList: LIST }),
      'GraphQL CheckoutPreview': () =>
        data({
          checkoutPreview: {
            preview: null,
            refusal: {
              code: 'TAX_PROBLEMS',
              message: 'Tax can’t be worked out for this order.',
              lines: [],
              taxProblems: [
                { lineNo: 1, code: 'NO_TAX_CODE', message: 'This product has no HSN code.' },
              ],
            },
          },
        }),
    });
    renderApp('/checkout?list=l1');
    expect(await screen.findByText('Line 1: This product has no HSN code.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Place order' }).disabled).toBe(
      true,
    );
  });
});
