import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  data,
  json,
  mockApi,
  notSignedIn,
  problem,
  ROW,
  SHELL,
  signedIn,
  renderApp,
} from '../test/mock-api.js';
import { INVALID_CREDENTIALS_MESSAGE, SESSION_ENDED_MESSAGE } from './sign-in.js';

const BUYER = { id: 'b1', email: SHELL.viewer.email, displayName: SHELL.viewer.displayName };
const products = () => data({ products: { nodes: [ROW], nextAfter: null } });

describe('signing in', () => {
  it('sends a signed-out buyer to sign-in, and back to the page they asked for', async () => {
    let session = false;
    const requests = mockApi({
      'GraphQL Shell': () => (session ? data(SHELL) : notSignedIn()),
      'GraphQL Products': () => (session ? products() : notSignedIn()),
      'POST /auth/sign-in': () => {
        session = true;
        return json({ user: BUYER, expiresAt: '2026-10-30T20:00:00Z' });
      },
    });
    const { router } = renderApp('/c/hex');
    expect(await screen.findByRole('heading', { name: 'Sign in to order' })).toBeTruthy();
    expect(router.state.location.search).toEqual({ redirect: '/c/hex' });
    // A first visit is not an ended session.
    expect(screen.queryByText(SESSION_ENDED_MESSAGE)).toBeNull();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Work email'), BUYER.email);
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Hex bolts' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/c/hex');
    expect(requests.find((r) => r.path === '/auth/sign-in')?.body).toEqual({
      email: BUYER.email,
      password: 'correct horse',
    });
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('shows one message for a wrong email, a wrong password or a locked account', async () => {
    mockApi({
      'GraphQL Shell': notSignedIn,
      'POST /auth/sign-in': () => problem(401, 'invalid_credentials', 'Invalid email or password'),
    });
    renderApp('/sign-in');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'nobody@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(INVALID_CREDENTIALS_MESSAGE)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });

  it('says when there were too many attempts', async () => {
    mockApi({
      'POST /auth/sign-in': () =>
        problem(429, 'too_many_attempts', 'Too many sign-in attempts. Try again later.'),
    });
    renderApp('/sign-in');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Too many sign-in attempts. Try again later.')).toBeTruthy();
  });

  it('says the session ended when a signed-in buyer gets a 401', async () => {
    let session = true;
    mockApi({
      ...signedIn(),
      'GraphQL Products': () => (session ? products() : notSignedIn()),
    });
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'All products' })).toBeTruthy();

    session = false;
    await router.navigate({ to: '/c/$categoryId', params: { categoryId: 'tools' } });
    expect(await screen.findByText(SESSION_ENDED_MESSAGE)).toBeTruthy();
    expect(router.state.location.search).toEqual({ redirect: '/c/tools', reason: 'session_ended' });
  });

  it('signs out and forgets the buyer', async () => {
    let session = true;
    const requests = mockApi({
      'GraphQL Shell': () => (session ? data(SHELL) : notSignedIn()),
      'GraphQL Products': products,
      'POST /auth/sign-out': () => {
        session = false;
        return new Response(null, { status: 204 });
      },
    });
    const { router } = renderApp('/');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to order' })).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-in');
    });
    expect(requests.some((r) => r.method === 'POST' && r.path === '/auth/sign-out')).toBe(true);
    expect(screen.queryByText(SHELL.viewer.displayName)).toBeNull();
  });
});
