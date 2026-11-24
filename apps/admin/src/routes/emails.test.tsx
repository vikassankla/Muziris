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

  it('shows a bounced email with its bounce type, and one not sent to a suppressed address', async () => {
    mockApi({
      ...signedIn(['notification.view']),
      'GET /notifications': () =>
        json({
          emails: [
            {
              ...EMAIL,
              status: 'bounced',
              bounceType: 'HardBounce',
              lastError: null,
              attempts: 1,
              sentAt: '2026-11-02T06:01:00.000Z',
            },
            { ...INVITE, status: 'suppressed', bounceType: null, lastError: null, attempts: 0 },
          ],
          nextAfter: null,
        }),
    });
    renderApp('/emails');
    expect(await screen.findByText('Bounced')).toBeTruthy();
    expect(screen.getByText('Hard bounce')).toBeTruthy();
    expect(screen.getByText('Not sent: address suppressed')).toBeTruthy();
  });
});

const SUPPRESSION = {
  id: '7c1e0a11-0000-4000-8000-000000000081',
  email: 'ravi@example.in',
  reason: 'hard_bounce',
  source: 'postmark',
  bounceType: 'HardBounce',
  bounceTypeCode: 1,
  outboxId: EMAIL.id,
  firstSeenAt: '2026-11-02T06:05:00.000Z',
  lastSeenAt: '2026-11-03T06:05:00.000Z',
};

describe('suppressed addresses', () => {
  it('lists suppressed addresses, searches them, and removes one after a warning about Postmark', async () => {
    const requests = mockApi({
      ...signedIn(['notification.view', 'notification.manage']),
      'GET /notifications/suppressions': () =>
        json({ suppressions: [SUPPRESSION], nextAfter: null }),
      [`DELETE /notifications/suppressions/${SUPPRESSION.id}`]: () =>
        json({ suppression: SUPPRESSION }),
    });
    renderApp('/emails?tab=suppressed&q=ravi');
    expect(await screen.findByText('ravi@example.in')).toBeTruthy();
    expect(screen.getByText('Hard bounce')).toBeTruthy();
    expect(screen.getByText('Postmark')).toBeTruthy();
    expect(
      requests.find((r) => r.path === '/notifications/suppressions')?.query.get('search'),
    ).toBe('ravi');
    await userEvent.click(screen.getByRole('button', { name: 'Remove ravi@example.in' }));
    expect(
      await screen.findByText(/reactivate it in Postmark too, or emails to it will bounce again/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove from the list' }));
    expect(
      requests.some(
        (r) => r.method === 'DELETE' && r.path === `/notifications/suppressions/${SUPPRESSION.id}`,
      ),
    ).toBe(true);
  });

  it('adds an address', async () => {
    const requests = mockApi({
      ...signedIn(['notification.view', 'notification.manage']),
      'GET /notifications/suppressions': () => json({ suppressions: [], nextAfter: null }),
      'POST /notifications/suppressions': () =>
        json(
          {
            suppression: {
              ...SUPPRESSION,
              email: 'meena@example.in',
              reason: 'manual',
              source: 'admin',
              bounceType: null,
              bounceTypeCode: null,
              outboxId: null,
            },
          },
          201,
        ),
    });
    renderApp('/emails?tab=suppressed');
    expect(await screen.findByText('No suppressed addresses')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add an address' }));
    await userEvent.type(screen.getByLabelText('Email address'), 'meena@example.in');
    await userEvent.click(screen.getByRole('button', { name: 'Add to the list' }));
    expect(await screen.findByText('Address added')).toBeTruthy();
    const post = requests.find(
      (r) => r.method === 'POST' && r.path === '/notifications/suppressions',
    );
    expect(post?.body).toEqual({ email: 'meena@example.in' });
  });

  it('shows the list without changes to an admin who may only look', async () => {
    mockApi({
      ...signedIn(['notification.view']),
      'GET /notifications/suppressions': () =>
        json({ suppressions: [SUPPRESSION], nextAfter: null }),
    });
    renderApp('/emails?tab=suppressed');
    expect(await screen.findByText('ravi@example.in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add an address' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove ravi@example.in' })).toBeNull();
  });
});
