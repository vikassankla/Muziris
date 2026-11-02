import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  data,
  json,
  mockApi,
  notSignedIn,
  problem,
  ROW,
  SHELL,
  renderApp,
} from '../test/mock-api.js';

const TOKEN = 'A'.repeat(20) + 'b'.repeat(23);
const INVITATION = {
  email: 'meera@acme.example',
  displayName: 'Meera',
  customerName: 'Acme Engineering',
  expiresAt: '2026-11-09T09:00:00.000Z',
};

/** The link from the email: the token in the fragment. */
function openLink(token = TOKEN) {
  window.history.replaceState(null, '', `/accept-invitation#token=${token}`);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('accepting an invitation', () => {
  it('reads the token from the link, sets a password and signs the buyer in', async () => {
    let session = false;
    const requests = mockApi({
      'GraphQL Shell': () => (session ? data(SHELL) : notSignedIn()),
      'GraphQL Products': () => data({ products: { nodes: [ROW], nextAfter: null } }),
      'POST /auth/invitation': () => json({ invitation: INVITATION }),
      'POST /auth/accept-invitation': () => {
        session = true;
        return json({ user: { id: 'b9', email: INVITATION.email, displayName: 'Meera' } }, 201);
      },
    });
    openLink();
    const { router } = renderApp('/accept-invitation');
    expect(await screen.findByRole('heading', { name: 'Welcome, Meera' })).toBeTruthy();
    expect(screen.getByText(/You are invited to order for Acme Engineering/)).toBeTruthy();
    // The token is gone from the address bar once read.
    expect(window.location.hash).toBe('');
    expect(requests.find((r) => r.path === '/auth/invitation')?.body).toEqual({ token: TOKEN });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Password'), 'a long and quiet passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account and sign in' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(requests.find((r) => r.path === '/auth/accept-invitation')?.body).toEqual({
      token: TOKEN,
      password: 'a long and quiet passphrase',
    });
    // No request carried the token in its URL.
    expect(requests.some((r) => r.path.includes(TOKEN))).toBe(false);
  });

  it('says why a used or expired link cannot be used', async () => {
    mockApi({
      'GraphQL Shell': notSignedIn,
      'POST /auth/invitation': () =>
        problem(410, 'invitation_expired', 'This invitation has expired. Ask for a new one.'),
    });
    openLink();
    renderApp('/accept-invitation');
    expect(
      await screen.findByRole('heading', { name: 'This invitation can’t be used' }),
    ).toBeTruthy();
    expect(screen.getByText('This invitation has expired. Ask for a new one.')).toBeTruthy();
  });

  it('shows the password policy refusal and keeps the form', async () => {
    mockApi({
      'GraphQL Shell': notSignedIn,
      'POST /auth/invitation': () => json({ invitation: INVITATION }),
      'POST /auth/accept-invitation': () =>
        problem(400, 'password_policy', 'The password does not meet the password policy'),
    });
    openLink();
    renderApp('/accept-invitation');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Password'), 'twelve chars');
    await user.click(screen.getByRole('button', { name: 'Create account and sign in' }));
    expect(await screen.findByText('The password does not meet the password policy')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Welcome, Meera' })).toBeTruthy();
  });

  it('refuses a link without a token, without calling the API', async () => {
    const requests = mockApi({ 'GraphQL Shell': notSignedIn });
    renderApp('/accept-invitation');
    expect(await screen.findByText('This invitation link is not valid')).toBeTruthy();
    expect(requests.some((r) => r.path.startsWith('/auth/'))).toBe(false);
  });
});
