import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn } from '../test/mock-api.js';

const EMAIL = {
  id: '7c1e0a11-0000-4000-8000-000000000071',
  kind: 'order_placed',
  recipient: 'neha@example.in',
  locale: 'en-IN',
  subject: 'Order MZ-000042 received',
  status: 'failed',
  attempts: 5,
  nextAttemptAt: '2026-11-02T09:00:00.000Z',
  lastError: 'smtp_550',
  createdAt: '2026-11-02T06:00:00.000Z',
  sentAt: null,
};
const INVITE = {
  ...EMAIL,
  id: '7c1e0a11-0000-4000-8000-000000000072',
  kind: 'buyer_invitation',
  subject: 'You are invited to order from Muziris',
};

describe('emails', () => {
  it('lists failed emails with their error and sends one again', async () => {
    const requests = mockApi({
      ...signedIn(['notification.view', 'notification.manage']),
      'GET /notifications': () => json({ emails: [EMAIL], nextAfter: null }),
      [`POST /notifications/${EMAIL.id}/retry`]: () =>
        json({ email: { ...EMAIL, status: 'queued', attempts: 0, lastError: null } }),
    });
    renderApp('/emails?state=failed');
    expect(await screen.findByText('Order MZ-000042 received')).toBeTruthy();
    expect(screen.getByText('Order received (buyer)')).toBeTruthy();
    expect(screen.getByText('smtp_550 · 5 attempts')).toBeTruthy();
    expect(requests.find((r) => r.path === '/notifications')?.query.get('status')).toBe('failed');
    await userEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText('Email queued again')).toBeTruthy();
  });

  it('explains why an invitation email cannot be sent again', async () => {
    mockApi({
      ...signedIn(['notification.view', 'notification.manage']),
      'GET /notifications': () => json({ emails: [INVITE], nextAfter: null }),
      [`POST /notifications/${INVITE.id}/retry`]: () =>
        problem(
          409,
          'notification_body_discarded',
          'This email held a secret and was emptied; send the invitation again instead',
        ),
    });
    renderApp('/emails');
    await userEvent.click(await screen.findByRole('button', { name: 'Send again' }));
    expect(
      await screen.findByText(
        'This email held a secret and was emptied; send the invitation again instead',
      ),
    ).toBeTruthy();
  });

  it('shows the list without "Send again" to an admin who may only look', async () => {
    mockApi({
      ...signedIn(['notification.view']),
      'GET /notifications': () => json({ emails: [EMAIL], nextAfter: null }),
    });
    renderApp('/emails');
    expect(await screen.findByText('Order MZ-000042 received')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
  });
});
