import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, notSignedIn, renderApp, signedIn } from '../test/mock-api.js';

const CUSTOMER = {
  id: '0b8f5a52-0000-4000-8000-000000000010',
  name: 'Kochi Industrial Supply',
  parentId: null,
  groupId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('session guard', () => {
  it('sends a visitor with no session to sign-in, remembering where they were going', async () => {
    const requests = mockApi({ 'GET /auth/me': notSignedIn });
    const { router } = renderApp('/customers?after=abc');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.search).toEqual({ redirect: '/customers?after=abc' });
    // The guard stopped at the session check; the customers list was never asked for.
    expect(requests.map((r) => r.path)).toEqual(['/auth/me']);
  });

  it('shows the screen to a signed-in admin', async () => {
    mockApi({
      ...signedIn(['customer.view']),
      'GET /customers': () => json({ customers: [CUSTOMER], nextAfter: null }),
    });
    renderApp('/customers');

    expect((await screen.findAllByRole('link', { name: CUSTOMER.name })).length).toBeGreaterThan(0);
    expect(screen.getByText('Asha Rao')).toBeTruthy();
  });

  it('sends the admin to sign-in when the session ends between the guard and the data', async () => {
    mockApi({ ...signedIn(['customer.view']), 'GET /customers': notSignedIn });
    const { router } = renderApp('/customers');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('checks the session again on every navigation', async () => {
    let signedInNow = true;
    mockApi({
      'GET /customers/groups': () => json({ customerGroups: [], nextAfter: null }),
      'GET /auth/me': () =>
        signedInNow
          ? json({ user: { id: 'a', realm: 'admin', email: 'a@x.in', displayName: 'A' } })
          : notSignedIn(),
      'GET /access/me': () => json({ permissions: ['customer.view'] }),
      'GET /customers': () => json({ customers: [CUSTOMER], nextAfter: null }),
    });
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: /, A$/ })).toBeTruthy();

    signedInNow = false;
    await router.navigate({ to: '/customers' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-in');
    });
  });
});
