import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn } from '../test/mock-api.js';

const ORDER_ID = '7c1e0a11-0000-4000-8000-000000000031';

const SUMMARY = {
  id: ORDER_ID,
  number: 'MZ-000042',
  websiteId: '7c1e0a11-0000-4000-8000-000000000001',
  customerId: '7c1e0a11-0000-4000-8000-000000000002',
  customerName: 'Acme Engineering Pvt Ltd',
  placedBy: '7c1e0a11-0000-4000-8000-000000000003',
  step: 'new',
  purchaseOrderNumber: 'AEPL/PO/26-27/1184',
  grandTotal: '57364.00',
  currency: 'INR',
  placedAt: '2026-10-26T08:35:00.000Z',
};

const ADDRESS = {
  label: 'Chakan stores',
  countryCode: 'IN',
  line1: 'Gat No. 118, Chakan Industrial Area Phase II',
  line2: null,
  city: 'Pune',
  regionCode: '27',
  postalCode: '410501',
  gstin: '27AAPFU0939F1ZV',
};

const ORDER = {
  ...SUMMARY,
  paymentMethod: 'terms',
  paymentTermDays: 30,
  dueOn: '2026-11-25',
  shippingMethod: 'Flat rate',
  taxProvider: 'tax_tables',
  sellerTaxId: '27AAPFU0939F1ZV',
  taxExemptionCertificate: null,
  subtotal: '48000.00',
  discount: '0.00',
  shipping: '250.00',
  shippingDiscount: '0.00',
  tax: '8685.00',
  lines: [
    {
      lineNo: 1,
      productId: '7c1e0a11-0000-4000-8000-000000000040',
      sku: 'BRG-6205-2RS',
      productName: 'Deep groove ball bearing 6205-2RS',
      unitCode: 'each',
      unitName: 'Each',
      quantity: '400',
      unitPrice: '120.00',
      subtotal: '48000.00',
      discount: '0.00',
      net: '48000.00',
      taxCode: '84821011',
    },
  ],
  taxes: [
    { lineNo: 1, name: 'CGST', rate: '0.09', taxable: '48000.00', amount: '4320.00' },
    { lineNo: 1, name: 'SGST', rate: '0.09', taxable: '48000.00', amount: '4320.00' },
    { lineNo: null, name: 'CGST', rate: '0.09', taxable: '250.00', amount: '22.50' },
    { lineNo: null, name: 'SGST', rate: '0.09', taxable: '250.00', amount: '22.50' },
  ],
  billingAddress: ADDRESS,
  shippingAddress: ADDRESS,
};

function view(step: string, transitions: string[], version = 1) {
  return {
    order: { ...ORDER, step },
    version,
    transitions,
    history: [
      {
        sequence: 1,
        transition: null,
        fromStep: null,
        toStep: 'new',
        actor: { type: 'buyer_user', id: SUMMARY.placedBy },
        note: null,
        occurredAt: SUMMARY.placedAt,
      },
    ],
  };
}

describe('orders', () => {
  it('lists orders with their status and total in the order’s currency', async () => {
    const requests = mockApi({
      ...signedIn(['order.view']),
      'GET /orders': () => json({ orders: [SUMMARY], nextAfter: null }),
    });
    renderApp('/orders?step=new');
    const link = await screen.findByRole('link', { name: 'MZ-000042' });
    const row = link.closest('tr')!;
    expect(within(row).getByText('Acme Engineering Pvt Ltd')).toBeTruthy();
    expect(within(row).getByText('New')).toBeTruthy();
    expect(within(row).getByText('₹57,364.00')).toBeTruthy();
    expect(requests.find((r) => r.path === '/orders')?.query.get('step')).toBe('new');
  });

  it('shows an order’s lines, its taxes added up per rate, and its addresses', async () => {
    mockApi({
      ...signedIn(['order.view']),
      [`GET /orders/${ORDER_ID}`]: () => json(view('new', ['confirm', 'decline'])),
    });
    renderApp(`/orders/${ORDER_ID}`);
    expect(await screen.findByRole('heading', { name: 'Order MZ-000042' })).toBeTruthy();
    expect(screen.getByText('Deep groove ball bearing 6205-2RS')).toBeTruthy();
    expect(screen.getByText('CGST 9%').nextSibling?.textContent).toBe('₹4,342.50');
    expect(screen.getByText('SGST 9%').nextSibling?.textContent).toBe('₹4,342.50');
    expect(screen.getAllByText('Maharashtra (27)', { exact: false })).toHaveLength(2);
    // Without order.manage there is nothing to press.
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
  });

  it('confirms an order with the version it showed, and shows a stale-version refusal', async () => {
    let calls = 0;
    const requests = mockApi({
      ...signedIn(['order.view', 'order.manage']),
      [`GET /orders/${ORDER_ID}`]: () =>
        json(calls === 0 ? view('new', ['confirm', 'decline']) : view('confirmed', [], 2)),
      [`POST /orders/${ORDER_ID}/transitions`]: () => {
        calls += 1;
        return calls === 1
          ? problem(409, 'stale_version', 'The order changed since you looked at it')
          : json(view('confirmed', ['start_processing'], 2));
      },
    });
    renderApp(`/orders/${ORDER_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText('The order changed since you looked at it')).toBeTruthy();
    const sent = requests.find((r) => r.method === 'POST');
    expect(sent?.body).toEqual({ transition: 'confirm', expectedVersion: 1 });
  });

  it('asks before declining', async () => {
    const requests = mockApi({
      ...signedIn(['order.view', 'order.manage']),
      [`GET /orders/${ORDER_ID}`]: () => json(view('new', ['confirm', 'decline'])),
      [`POST /orders/${ORDER_ID}/transitions`]: () => json(view('declined', [], 2)),
    });
    renderApp(`/orders/${ORDER_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Decline order…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decline order' }));
    await screen.findByText('Order declined');
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      transition: 'decline',
      expectedVersion: 1,
    });
  });
});
