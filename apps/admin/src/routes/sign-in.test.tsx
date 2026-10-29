import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../lib/redirect.js';
import { formatRetryAfter } from '../lib/retry.js';
import {
  ADMIN,
  expectOnlyPreferencesStored,
  json,
  mockApi,
  problem,
  renderApp,
  signedIn,
  storedText,
} from '../test/mock-api.js';
import { INVALID_CREDENTIALS_MESSAGE } from './sign-in.js';

async function submit(email = 'asha@example.com', password = 'correct horse battery') {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('sign-in', () => {
  it('posts the email and password and goes where the admin was heading', async () => {
    const requests = mockApi({
      ...signedIn(['customer.view']),
      'POST /auth/sign-in': () => json({ user: ADMIN, expiresAt: '2026-10-28T12:00:00.000Z' }),
      'GET /customers': () => json({ customers: [], nextAfter: null }),
    });
    const { router } = renderApp('/sign-in?redirect=%2Fcustomers');
    await submit();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/customers');
    });
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      email: 'asha@example.com',
      password: 'correct horse battery',
    });
  });

  it('shows one generic message for invalid_credentials and clears the password', async () => {
    mockApi({
      'POST /auth/sign-in': () =>
        problem(401, 'invalid_credentials', 'Email or password is incorrect'),
    });
    renderApp('/sign-in');
    await submit();

    expect(await screen.findByText(INVALID_CREDENTIALS_MESSAGE)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
    // A wrong password on the sign-in form is not an expired session: no redirect loop.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it.each([
    ['120', 'Try again in 2 minutes.'],
    ['45', 'Try again in 45 seconds.'],
    ['900', 'Try again in 15 minutes.'],
  ])('shows too_many_attempts with Retry-After %s as "%s"', async (retryAfter, message) => {
    mockApi({
      'POST /auth/sign-in': () =>
        problem(
          429,
          'too_many_attempts',
          'Too many sign-in attempts. Try again later.',
          {},
          { 'retry-after': retryAfter },
        ),
    });
    renderApp('/sign-in');
    await submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      `Too many sign-in attempts. ${message}`,
    );
    // The form waits until the time is up.
    expect(screen.getByLabelText<HTMLInputElement>('Password').disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(true);
  });

  it('says "try again later" when too_many_attempts has no Retry-After', async () => {
    mockApi({
      'POST /auth/sign-in': () =>
        problem(429, 'too_many_attempts', 'Too many sign-in attempts. Try again later.'),
    });
    renderApp('/sign-in');
    await submit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many sign-in attempts. Try again later.',
    );
  });

  it('shows the generic title for a 500 and none of its detail', async () => {
    mockApi({
      'POST /auth/sign-in': () =>
        problem(500, 'internal_error', 'Argon2 worker crashed', { detail: 'ECONNREFUSED 5432' }),
    });
    renderApp('/sign-in');
    await submit();
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    expect(screen.queryByText(/Argon2|ECONNREFUSED/)).toBeNull();
  });

  it('shows the title of an untrusted_origin refusal', async () => {
    mockApi({
      'POST /auth/sign-in': () =>
        problem(403, 'untrusted_origin', 'This request did not come from a trusted site'),
    });
    renderApp('/sign-in');
    await submit();
    expect(await screen.findByText('This request did not come from a trusted site')).toBeTruthy();
  });

  it('says so when the API cannot be reached', async () => {
    mockApi({});
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    renderApp('/sign-in');
    await submit();
    expect(await screen.findByText(/The API could not be reached/)).toBeTruthy();
  });

  it('signs out and returns to sign-in', async () => {
    const requests = mockApi({
      ...signedIn([]),
      'POST /auth/sign-out': () => new Response(null, { status: 204 }),
    });
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Asha Rao/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-in');
    });
    expect(requests.some((r) => r.method === 'POST' && r.path === '/auth/sign-out')).toBe(true);
  });

  it('keeps nothing about the session in browser storage', async () => {
    mockApi({
      ...signedIn(['customer.view']),
      'POST /auth/sign-in': () => json({ user: ADMIN, expiresAt: '2026-10-28T12:00:00.000Z' }),
    });
    const { router } = renderApp('/sign-in');
    await submit();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expectOnlyPreferencesStored();
    expect(storedText()).not.toMatch(/asha|correct horse|session/i);
  });
});

describe('safeRedirect', () => {
  it.each([
    ['/customers?after=x', '/customers?after=x'],
    ['/', '/'],
    ['//evil.example', undefined],
    ['/\\evil.example', undefined],
    ['https://evil.example', undefined],
    ['/sign-in?redirect=/x', undefined],
    [42, undefined],
  ])('%j gives %j', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });
});

describe('formatRetryAfter', () => {
  it.each([
    [1, '1 second'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [61, '2 minutes'],
  ])('%d seconds reads "%s"', (seconds, text) => {
    expect(formatRetryAfter(seconds)).toBe(text);
  });
});
