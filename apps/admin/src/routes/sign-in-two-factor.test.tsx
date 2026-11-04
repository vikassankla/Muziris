import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
import { INVALID_CODE_MESSAGE } from './sign-in-two-factor.js';

const SECRET = 'ABCD'.repeat(8);
const URI = `otpauth://totp/Muziris:asha%40example.com?secret=${SECRET}&issuer=Muziris`;
const CODES = Array.from({ length: 10 }, (_, i) => `ABCDE-FGH${String(i).padStart(2, '2')}`);
const SIGNED_IN = { user: ADMIN, expiresAt: '2026-10-28T12:00:00.000Z' };

function enterCode(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('the code step (ADR 0026)', () => {
  it('refuses a wrong code with one message and clears the field', async () => {
    mockApi({
      'POST /auth/two-factor/verify': () => problem(401, 'invalid_code', 'The code is incorrect'),
    });
    renderApp('/sign-in/code');
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeTruthy();
    enterCode('Authentication code', '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(INVALID_CODE_MESSAGE)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Authentication code').value).toBe('');
  });

  it('takes a recovery code instead', async () => {
    const requests = mockApi({
      ...signedIn([]),
      'POST /auth/two-factor/verify': () => json(SIGNED_IN),
    });
    const { router } = renderApp('/sign-in/code');
    fireEvent.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    expect(screen.getByRole('heading', { name: 'Enter a recovery code' })).toBeTruthy();
    enterCode('Recovery code', 'abcde-fghjk');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(requests.find((r) => r.path === '/auth/two-factor/verify')?.body).toEqual({
      recoveryCode: 'abcde-fghjk',
    });
  });

  it('goes back to sign-in when the five minutes are up', async () => {
    mockApi({
      'POST /auth/two-factor/verify': () =>
        problem(401, 'two_factor_expired', 'Sign in again to continue'),
    });
    const { router } = renderApp('/sign-in/code?redirect=%2Forders');
    await screen.findByLabelText('Authentication code');
    enterCode('Authentication code', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(
      await screen.findByText('That took longer than five minutes. Sign in again.'),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.search).toMatchObject({ redirect: '/orders' });
  });
});

describe('enrolment (ADR 0026)', () => {
  it('shows the QR code and key, confirms a code, then the recovery codes once', async () => {
    const requests = mockApi({
      ...signedIn([]),
      'POST /auth/two-factor/enrolment': () => json({ secret: SECRET, uri: URI }),
      'POST /auth/two-factor/enrolment/confirm': () => json({ ...SIGNED_IN, recoveryCodes: CODES }),
    });
    const { router } = renderApp('/sign-in/enrol?redirect=%2Forders');
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Setup key').textContent).toBe(
      'ABCD ABCD ABCD ABCD ABCD ABCD ABCD ABCD',
    );
    // One start per visit, so the secret on screen is the one stored.
    expect(requests.filter((r) => r.path === '/auth/two-factor/enrolment')).toHaveLength(1);

    enterCode('Authentication code', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Recovery codes' }).textContent).toContain(CODES[0]);

    const continueButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' });
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I have saved these codes somewhere safe'));
    fireEvent.click(continueButton);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/orders');
    });
    expectOnlyPreferencesStored();
    expect(storedText()).not.toContain(SECRET);
    expect(storedText()).not.toContain(CODES[0]);
  });

  it('sends an admin who is already enrolled to the code', async () => {
    mockApi({
      'POST /auth/two-factor/enrolment': () =>
        problem(409, 'already_enrolled', 'Two-factor sign-in is already set up'),
    });
    const { router } = renderApp('/sign-in/enrol');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-in/code');
    });
  });
});
