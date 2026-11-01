import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handToCheckout, forgetQuickOrder } from '../lib/checkout.js';
import { openRazorpay, type RazorpayOptions } from '../lib/gateways.js';
import type { OrderResult } from '../operations/generated.js';
import { data, mockApi, renderApp, signedIn, type MockRequest } from '../test/mock-api.js';

// The gateways' own scripts cannot run here; the panel's calls to them are checked instead.
vi.mock('../lib/gateways.js', () => ({ openRazorpay: vi.fn(), loadStripe: vi.fn() }));

const inr = (amount: string) => ({ amount, currency: 'INR' });

const ADDRESS = {
  label: 'Shop',
  countryCode: 'IN',
  line1: 'MG Road',
  line2: null,
  city: 'Kochi',
  regionCode: '32',
  postalCode: '682016',
  gstin: null,
};

const ORDER: NonNullable<OrderResult['order']> = {
  number: 'MZ-000050',
  step: 'NEW',
  placedAt: '2026-11-20T06:00:00.000Z',
  customerName: 'Kochi Traders',
  purchaseOrderNumber: null,
  currency: 'INR',
  lines: [],
  taxes: [],
  shippingMethod: 'Flat rate',
  subtotal: inr('960.00'),
  discount: inr('0.00'),
  shipping: inr('0.00'),
  shippingDiscount: inr('0.00'),
  tax: inr('0.00'),
  grandTotal: inr('960.00'),
  paymentMethod: 'RAZORPAY',
  payment: { status: 'PENDING' },
  paymentTermDays: 0,
  dueOn: null,
  sellerTaxId: null,
  taxExemptionCertificate: null,
  billingAddress: ADDRESS,
  shippingAddress: ADDRESS,
};

const byOperation = (requests: MockRequest[], name: string) =>
  requests.filter((r) => r.operationName === name);

afterEach(() => {
  forgetQuickOrder();
});

describe('paying online', () => {
  it('lets the buyer pick how to pay at checkout, and places the order with it', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL CheckoutAddresses': () =>
        data({
          viewer: {
            customer: {
              addresses: [
                { ...ADDRESS, id: 'a1', isDefaultBilling: true, isDefaultShipping: true },
              ],
            },
          },
        }),
      'GraphQL CheckoutPreview': () =>
        data({
          checkoutPreview: {
            preview: {
              totals: {
                currency: 'INR',
                lines: [],
                taxes: [],
                shippingMethod: 'Flat rate',
                subtotal: inr('960.00'),
                discount: inr('0.00'),
                shipping: inr('0.00'),
                shippingDiscount: inr('0.00'),
                tax: inr('0.00'),
                grandTotal: inr('960.00'),
              },
              paymentMethods: ['RAZORPAY', 'TERMS'],
              paymentTermDays: 30,
              dueOn: '2026-12-20',
            },
            refusal: null,
          },
        }),
      'GraphQL PlaceOrder': () =>
        data({ placeOrder: { order: { number: 'MZ-000050' }, replayed: false, refusal: null } }),
      'GraphQL Order': () => data({ order: ORDER }),
      'GraphQL CheckPayment': () =>
        data({ checkPayment: { payment: { status: 'PENDING' }, refusal: null } }),
    });
    handToCheckout([{ productId: 'p1', unitCode: 'EA', quantity: '2' }]);
    renderApp('/checkout');
    const online = await screen.findByLabelText('Card, UPI or net banking');
    expect((online as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText('Payment terms (net 30)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Place order · ₹960.00' }));
    expect(await screen.findByRole('heading', { name: 'Order MZ-000050' })).toBeTruthy();
    expect(byOperation(requests, 'PlaceOrder')[0]?.variables).toMatchObject({
      input: { paymentMethod: 'RAZORPAY' },
    });
  });

  it('opens Razorpay Checkout for an unpaid order, then shows it paid', async () => {
    let paid = false;
    const requests = mockApi({
      ...signedIn(),
      'GraphQL Order': () =>
        data({ order: { ...ORDER, payment: { status: paid ? 'PAID' : 'PENDING' } } }),
      'GraphQL CheckPayment': () =>
        data({
          checkPayment: { payment: { status: paid ? 'PAID' : 'PENDING' }, refusal: null },
        }),
      'GraphQL StartPayment': () =>
        data({
          startPayment: {
            stripe: null,
            razorpay: {
              keyId: 'rzp_test_key',
              orderId: 'order_1',
              amount: { minorUnits: '96000', currency: 'INR' },
            },
            refusal: null,
          },
        }),
    });
    renderApp('/orders/MZ-000050');
    expect(await screen.findByText('Not paid yet')).toBeTruthy();
    await waitFor(() => {
      expect(byOperation(requests, 'CheckPayment')).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Pay now · ₹960.00' }));
    await waitFor(() => {
      expect(openRazorpay).toHaveBeenCalled();
    });
    const options = vi.mocked(openRazorpay).mock.calls[0]?.[0] as RazorpayOptions;
    expect(options).toMatchObject({
      key: 'rzp_test_key',
      order_id: 'order_1',
      amount: 96000,
      currency: 'INR',
      description: 'Order MZ-000050',
    });
    paid = true;
    options.handler();
    expect(await screen.findByText('Paid')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
  });

  it('shows why paying cannot start', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL Order': () => data({ order: ORDER }),
      'GraphQL CheckPayment': () =>
        data({ checkPayment: { payment: { status: 'PENDING' }, refusal: null } }),
      'GraphQL StartPayment': () =>
        data({
          startPayment: {
            stripe: null,
            razorpay: null,
            refusal: {
              code: 'GATEWAY_UNAVAILABLE',
              message: 'The payment service did not answer. Try again in a minute.',
            },
          },
        }),
    });
    renderApp('/orders/MZ-000050');
    await userEvent.click(await screen.findByRole('button', { name: 'Pay now · ₹960.00' }));
    expect(
      await screen.findByText('The payment service did not answer. Try again in a minute.'),
    ).toBeTruthy();
  });
});
