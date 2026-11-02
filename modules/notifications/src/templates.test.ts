import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS } from './db/schema.js';
import { escapeHtml, renderEmail, type EmailContext, type EmailData } from './templates.js';

const IN: EmailContext = { shopName: 'Kochi Bearings', locale: 'en-IN', timeZone: 'Asia/Kolkata' };
const US: EmailContext = { shopName: 'Ohio Supply', locale: 'en-US', timeZone: 'America/New_York' };

const order = {
  buyerName: 'Asha Menon',
  orderNumber: 'MZ-000042',
  total: { amount: '57364.00', currency: 'INR' },
  orderUrl: 'https://shop.example.in/orders/MZ-000042',
  purchaseOrderNumber: 'AEPL/PO/1184',
  dueOn: '2026-11-25',
};

/** One example of every kind in the catalogue. */
const EXAMPLES: Record<(typeof NOTIFICATION_KINDS)[number], EmailData> = {
  buyer_invitation: {
    kind: 'buyer_invitation',
    displayName: 'Asha Menon',
    customerName: 'Acme Engineering',
    acceptUrl: 'https://shop.example.in/accept-invitation#token=abc',
    expiresAt: new Date('2026-11-27T06:30:00Z'),
  },
  order_placed: { kind: 'order_placed', ...order },
  order_received: {
    kind: 'order_received',
    orderNumber: 'MZ-000042',
    customerName: 'Acme Engineering',
    total: order.total,
    purchaseOrderNumber: null,
    paymentMethod: 'On terms',
  },
  order_confirmed: { kind: 'order_confirmed', ...order },
  order_declined: { kind: 'order_declined', ...order, note: 'Out of stock until March' },
  order_completed: { kind: 'order_completed', ...order, dueOn: null },
  payment_received: {
    kind: 'payment_received',
    buyerName: 'Asha Menon',
    orderNumber: 'MZ-000042',
    amount: order.total,
    orderUrl: order.orderUrl,
  },
  payment_failed: {
    kind: 'payment_failed',
    buyerName: 'Asha Menon',
    orderNumber: 'MZ-000042',
    amount: order.total,
    orderUrl: order.orderUrl,
  },
};

describe('email templates', () => {
  it.each(NOTIFICATION_KINDS)('renders %s', (kind) => {
    expect(renderEmail(EXAMPLES[kind], IN)).toMatchSnapshot();
  });

  it('formats money and dates for the locale and the website time zone', () => {
    const placed = renderEmail(EXAMPLES.order_placed, IN);
    expect(placed.text).toContain('Total: ₹57,364.00');
    expect(placed.text).toContain('Payment due: 25 Nov 2026');
    const us = renderEmail(
      { kind: 'order_placed', ...order, total: { amount: '1234567.5', currency: 'USD' } },
      US,
    );
    expect(us.text).toContain('Total: $1,234,567.50');
    expect(us.text).toContain('Payment due: Nov 25, 2026');
    const invite = renderEmail(EXAMPLES.buyer_invitation, IN);
    expect(invite.text).toContain('27 Nov 2026, 12:00 pm IST');
  });

  it('escapes every value in the HTML, and leaves the text as written', () => {
    const email = renderEmail(
      {
        kind: 'order_declined',
        ...order,
        buyerName: '<script>alert(1)</script>',
        note: 'Tom & "Jerry"',
        orderUrl: 'https://shop.example.in/orders/x"><img src=x>',
      },
      { ...IN, shopName: "O'Brien <Tools>" },
    );
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('Tom &amp; &quot;Jerry&quot;');
    expect(email.html).toContain('O&#39;Brien &lt;Tools&gt;');
    expect(email.text).toContain('Hello <script>alert(1)</script>,');
  });

  it('escapes the five HTML special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
