import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderApp, signedIn } from '../test/mock-api.js';

const STRIPE_OFF = {
  gateway: 'stripe',
  name: 'Stripe',
  configured: false,
  mode: null,
  publicKey: null,
  variables: [
    { name: 'STRIPE_SECRET_KEY', set: false },
    { name: 'STRIPE_PUBLISHABLE_KEY', set: false },
    { name: 'STRIPE_WEBHOOK_SECRET', set: false },
  ],
  currencies: ['USD'],
  methods: ['stripe_card', 'stripe_ach'],
  webhookUrl: 'https://shop.example.com/webhooks/stripe',
  lastEvent: null,
  refusedEvents7Days: 0,
};
const RAZORPAY_ON = {
  gateway: 'razorpay',
  name: 'Razorpay',
  configured: true,
  mode: 'test',
  publicKey: 'rzp_test_shown',
  variables: [
    { name: 'RAZORPAY_KEY_ID', set: true },
    { name: 'RAZORPAY_KEY_SECRET', set: true },
    { name: 'RAZORPAY_WEBHOOK_SECRET', set: true },
  ],
  currencies: ['INR'],
  methods: ['razorpay'],
  webhookUrl: 'https://shop.example.com/webhooks/razorpay',
  lastEvent: {
    receivedAt: '2026-11-19T06:00:00.000Z',
    type: 'payment.captured',
    outcome: 'unknown_payment',
  },
  refusedEvents7Days: 2,
};
const WEBSITES = [
  {
    id: '7c1e0a11-0000-4000-8000-0000000000a1',
    name: 'Muziris India',
    currency: 'INR',
    listed: ['razorpay', 'terms'],
    offered: ['razorpay', 'terms'],
    warnings: [],
  },
  {
    id: '7c1e0a11-0000-4000-8000-0000000000a2',
    name: 'Muziris US',
    currency: 'USD',
    listed: ['terms', 'stripe_card'],
    offered: ['terms'],
    warnings: ['Card (Stripe) is not offered: its keys are not set on the server.'],
  },
];

describe('payments', () => {
  it('shows each gateway, its webhook address and what each website offers, under System', async () => {
    mockApi({
      ...signedIn(['payment.view', 'setting.view']),
      'GET /payments/gateways': () =>
        json({ gateways: [STRIPE_OFF, RAZORPAY_ON], websites: WEBSITES }),
    });
    renderApp('/payments');
    expect(await screen.findByRole('heading', { name: 'Payments', level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Payments' })).toBeTruthy();

    const stripe = screen.getByRole('region', { name: 'Stripe' });
    expect(within(stripe).getByText('Not configured')).toBeTruthy();
    expect(within(stripe).getByText('https://shop.example.com/webhooks/stripe')).toBeTruthy();
    expect(within(stripe).getByText('STRIPE_SECRET_KEY')).toBeTruthy();

    const razorpay = screen.getByRole('region', { name: 'Razorpay' });
    expect(within(razorpay).getByText('Configured')).toBeTruthy();
    expect(within(razorpay).getByText('Test mode')).toBeTruthy();
    expect(within(razorpay).getByText('rzp_test_shown')).toBeTruthy();
    expect(within(razorpay).getByText(/payment\.captured/)).toBeTruthy();
    expect(within(razorpay).getByText('Payment not found')).toBeTruthy();
    expect(within(razorpay).getByText('2 refused in the last 7 days')).toBeTruthy();
    expect(
      within(razorpay).getByRole('button', { name: 'Copy the Razorpay webhook address' }),
    ).toBeTruthy();

    // No field takes a key: they stay in the env file.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { name: 'How to change the keys' })).toBeTruthy();

    const us = screen.getByText('Muziris US').closest('tr');
    expect(us).toBeTruthy();
    expect(within(us!).getByText('On payment terms')).toBeTruthy();
    expect(
      within(us!).getByText('Card (Stripe) is not offered: its keys are not set on the server.'),
    ).toBeTruthy();
    const change = within(us!).getByRole('link', { name: 'Change for Muziris US' });
    // The Settings page for that website; its "group" parameter is a customer group, so none.
    expect(change.getAttribute('href')).toBe(
      '/settings?website=7c1e0a11-0000-4000-8000-0000000000a2',
    );
  });

  it('says when no webhook has arrived yet', async () => {
    mockApi({
      ...signedIn(['payment.view']),
      'GET /payments/gateways': () => json({ gateways: [STRIPE_OFF], websites: [] }),
    });
    renderApp('/payments');
    const stripe = await screen.findByRole('region', { name: 'Stripe' });
    expect(within(stripe).getByText('No webhook received yet')).toBeTruthy();
  });
});
