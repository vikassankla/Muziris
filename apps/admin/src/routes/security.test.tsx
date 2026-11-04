import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn } from '../test/mock-api.js';

const STATUS = { enrolled: true, confirmedAt: '2026-11-03T09:00:00.000Z', recoveryCodesLeft: 2 };
const CODES = Array.from({ length: 10 }, (_, i) => `NEWCO-DES${String(i).padStart(2, '2')}`);

describe('the Security page (ADR 0026)', () => {
  it('warns when few recovery codes are left, and makes new ones for the password and a code', async () => {
    const requests = mockApi({
      ...signedIn([]),
      'GET /auth/two-factor': () => json({ twoFactor: STATUS }),
      'POST /auth/two-factor/recovery-codes': () => json({ recoveryCodes: CODES }),
    });
    renderApp('/account/security');
    expect(await screen.findByText(/2 of 10 left/)).toBeTruthy();
    expect(screen.getByText('You are running out of recovery codes. Make new ones.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New recovery codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'New recovery codes' });
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.change(within(dialog).getByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make new codes' }));
    expect(
      await screen.findByRole('heading', { name: 'Save your new recovery codes' }),
    ).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Recovery codes' }).textContent).toContain(CODES[9]);
    expect(requests.find((r) => r.path === '/auth/two-factor/recovery-codes')?.body).toEqual({
      password: 'correct horse battery',
      code: '123456',
    });
  });

  it('says when the password or code was wrong', async () => {
    mockApi({
      ...signedIn([]),
      'GET /auth/two-factor': () => json({ twoFactor: { ...STATUS, recoveryCodesLeft: 10 } }),
      'POST /auth/two-factor/replacement': () =>
        problem(401, 'invalid_code', 'The code is incorrect'),
    });
    renderApp('/account/security');
    fireEvent.click(await screen.findByRole('button', { name: 'Move to a new phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to a new phone' });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.change(within(dialog).getByLabelText('Code from your authenticator app'), {
      target: { value: '000000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(
      await within(dialog).findByText(
        'The password or code is incorrect, or the account is temporarily locked.',
      ),
    ).toBeTruthy();
  });
});
