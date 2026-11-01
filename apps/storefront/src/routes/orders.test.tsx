import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OrderResult } from '../operations/generated.js';
import { data, mockApi, renderApp, signedIn } from '../test/mock-api.js';

const inr = (amount: string) => ({ amount, currency: 'INR' });

const ADDRESS = {
  label: 'Kochi works',
  countryCode: 'IN',
  line1: 'Plot 12, Kakkanad',
  line2: null,
  city: 'Kochi',
  regionCode: '32',
  postalCode: '682030',
  gstin: '32AAPFU0939F1ZX',
};

const ORDER: NonNullable<OrderResult['order']> = {
  number: 'MZ-000042',
  step: 'CONFIRMED',
  placedAt: '2026-10-26T08:35:00.000Z',
  customerName: 'Kochi Traders',
  purchaseOrderNumber: 'KT-PO-118',
  currency: 'INR',
  lines: [
    {
      lineNo: 1,
      sku: 'HB-M8-40',
      productName: 'Hex bolt M8 × 40, zinc plated',
      unitName: 'Each',
      quantity: '400',
      unitPrice: inr('12.50'),
      net: inr('5000.00'),
    },
  ],
  taxes: [
    { lineNo: 1, name: 'IGST', rate: '0.18', amount: inr('900.00') },
    { lineNo: null, name: 'IGST', rate: '0.18', amount: inr('45.00') },
  ],
  shippingMethod: 'Flat rate',
  subtotal: inr('5000.00'),
  discount: inr('0.00'),
  shipping: inr('250.00'),
  shippingDiscount: inr('0.00'),
  tax: inr('945.00'),
  grandTotal: inr('6195.00'),
  paymentMethod: 'TERMS',
  payment: null,
  paymentTermDays: 30,
  dueOn: '2026-11-25',
  sellerTaxId: '27AAPFU0939F1ZV',
  taxExemptionCertificate: null,
  billingAddress: ADDRESS,
  shippingAddress: ADDRESS,
};

describe('orders', () => {
  it('lists the buyer’s orders and pages to older ones', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL Orders': () =>
        data({
          orders: {
            nodes: [
              {
                number: ORDER.number,
                step: ORDER.step,
                placedAt: ORDER.placedAt,
                customerName: ORDER.customerName,
                purchaseOrderNumber: ORDER.purchaseOrderNumber,
                grandTotal: ORDER.grandTotal,
              },
            ],
            nextAfter: 'cursor-2',
          },
        }),
    });
    renderApp('/orders');
    const row = (await screen.findByRole('link', { name: 'MZ-000042' })).closest('tr')!;
    expect(within(row).getByText('Confirmed')).toBeTruthy();
    expect(within(row).getByText('₹6,195.00')).toBeTruthy();
    expect(within(row).getByText('26 Oct 2026, 14:05 IST')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Older' }).getAttribute('href')).toContain(
      'after=cursor-2',
    );
    expect(requests.find((r) => r.operationName === 'Orders')?.variables).toEqual({ first: 20 });
  });

  it('says so when the buyer has no orders', async () => {
    mockApi({
      ...signedIn(),
      'GraphQL Orders': () => data({ orders: { nodes: [], nextAfter: null } }),
    });
    renderApp('/orders');
    expect(await screen.findByText('No orders yet')).toBeTruthy();
  });

  it('shows an order with its taxes added up per rate', async () => {
    mockApi({ ...signedIn(), 'GraphQL Order': () => data({ order: ORDER }) });
    renderApp('/orders/MZ-000042');
    expect(await screen.findByRole('heading', { name: 'Order MZ-000042' })).toBeTruthy();
    expect(screen.getByText('IGST 18%').nextSibling?.textContent).toBe('₹945.00');
    expect(screen.getByText('Total').nextSibling?.textContent).toBe('₹6,195.00');
    expect(screen.getByText('25 Nov 2026')).toBeTruthy();
  });

  it('treats an order the buyer may not see as not found', async () => {
    mockApi({ ...signedIn(), 'GraphQL Order': () => data({ order: null }) });
    renderApp('/orders/MZ-999999');
    expect(await screen.findByText("We can't find that order")).toBeTruthy();
  });
});
