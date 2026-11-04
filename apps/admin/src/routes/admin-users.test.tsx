import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, json, mockApi, problem, renderApp, signedIn } from '../test/mock-api.js';

// Admin users and admin invitations (ADR 0028).

const ADMINISTRATOR = {
  id: 'r1',
  code: 'administrator',
  name: 'Administrator',
  description: 'Every permission',
  isBuiltIn: true,
  grantsAllPermissions: true,
  permissions: [
    'admin_user.view',
    'admin_user.manage',
    'admin_role.assign',
    'order.view',
    'tax.manage',
  ],
};
const ORDERS = {
  id: 'r2',
  code: 'orders',
  name: 'Order desk',
  description: '',
  isBuiltIn: false,
  grantsAllPermissions: false,
  permissions: ['order.view'],
};
const ME = {
  id: ADMIN.id,
  displayName: 'Asha Rao',
  email: ADMIN.email,
  status: 'active',
  twoFactor: true,
  lastSignInAt: '2026-11-04T03:30:00.000Z',
  roles: [{ id: 'r1', name: 'Administrator' }],
};
const RAVI = {
  id: '6f1d2c4e-0000-4000-8000-000000000002',
  displayName: 'Ravi Pillai',
  email: 'ravi@example.com',
  status: 'invited',
  twoFactor: false,
  lastSignInAt: null,
  roles: [],
};
const MEERA = {
  ...RAVI,
  id: '6f1d2c4e-0000-4000-8000-000000000003',
  displayName: 'Meera Nair',
  email: 'meera@example.com',
  status: 'active',
  twoFactor: true,
  lastSignInAt: '2026-11-03T05:00:00.000Z',
  roles: [{ id: 'r2', name: 'Order desk' }],
};

function adminUsersApi(permissions: string[], users: unknown[] = [ME, RAVI, MEERA]) {
  return {
    ...signedIn(permissions),
    'GET /access/admin-users': () => json({ adminUsers: users, nextAfter: null }),
    'GET /access/roles': () => json({ roles: [ADMINISTRATOR, ORDERS] }),
  };
}

describe('admin users', () => {
  it('lists admin users with their roles, two-factor sign-in, status and last sign-in', async () => {
    mockApi(adminUsersApi(['admin_user.view']));
    renderApp('/admin-users');
    const ravi = (await screen.findByText('Ravi Pillai')).closest('tr');
    if (!ravi) throw new Error('no row');
    expect(within(ravi).getByText('Invited')).toBeTruthy();
    expect(within(ravi).getByText('Not set up')).toBeTruthy();
    expect(within(ravi).getByText('Never')).toBeTruthy();
    expect(within(ravi).getByText('No roles')).toBeTruthy();
    const me = screen.getByText(ADMIN.email).closest('tr');
    if (!me) throw new Error('no row');
    expect(within(me).getByText('You')).toBeTruthy();
    expect(within(me).getByText('Administrator')).toBeTruthy();
    expect(within(me).getByText('On')).toBeTruthy();
    // Read-only without admin_user.manage.
    expect(screen.queryByRole('button', { name: 'Invite an admin user' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Admin users' })).toBeTruthy();
  });

  it('invites an admin with the roles the inviter may give', async () => {
    const requests = mockApi({
      ...adminUsersApi([
        'admin_user.view',
        'admin_user.manage',
        'admin_role.view',
        'admin_role.assign',
        'order.view',
      ]),
      'POST /access/admin-users': () => json({ adminUser: RAVI }, 201),
    });
    renderApp('/admin-users?new=true');
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'Invite an admin user' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Ravi Pillai' } });
    fireEvent.change(within(sheet).getByLabelText('Email'), {
      target: { value: 'ravi@example.com' },
    });
    // The administrator role grants permissions this admin does not hold.
    expect(
      within(sheet).getByRole('checkbox', { name: 'Administrator' }).hasAttribute('disabled'),
    ).toBe(true);
    await user.click(within(sheet).getByRole('checkbox', { name: 'Order desk' }));
    await user.click(within(sheet).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        displayName: 'Ravi Pillai',
        email: 'ravi@example.com',
        roleIds: ['r2'],
      });
    });
  });

  it('says when the email is taken, under the field', async () => {
    mockApi({
      ...adminUsersApi(['admin_user.view', 'admin_user.manage']),
      'POST /access/admin-users': () =>
        problem(409, 'email_taken', 'An admin user with this email already exists'),
    });
    renderApp('/admin-users?new=true');
    const sheet = await screen.findByRole('dialog', { name: 'Invite an admin user' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Meera' } });
    fireEvent.change(within(sheet).getByLabelText('Email'), {
      target: { value: 'meera@example.com' },
    });
    // Without admin_role.assign there are no roles to give.
    expect(within(sheet).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send invitation' }));
    expect(await within(sheet).findByText('An admin user has this email.')).toBeTruthy();
  });

  it('offers each action only where it applies, and shows the last administrator refusal', async () => {
    const requests = mockApi({
      ...adminUsersApi(['admin_user.view', 'admin_user.manage']),
      [`POST /access/admin-users/${RAVI.id}/invitation`]: () => json({ adminUser: RAVI }),
      [`POST /access/admin-users/${MEERA.id}/disable`]: () =>
        problem(
          409,
          'last_administrator',
          'At least one admin user must keep the administrator role',
        ),
    });
    renderApp('/admin-users');
    const user = userEvent.setup();

    // Your own row: no disable, no two-factor reset.
    await user.click(await screen.findByRole('button', { name: 'Actions for Asha Rao' }));
    expect(screen.queryByRole('menuitem', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Reset two-factor' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Actions for Ravi Pillai' }));
    expect(screen.queryByRole('menuitem', { name: 'Reset two-factor' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Send invitation again' }));
    await waitFor(() => {
      expect(requests.some((r) => r.path === `/access/admin-users/${RAVI.id}/invitation`)).toBe(
        true,
      );
    });

    await user.click(screen.getByRole('button', { name: 'Actions for Meera Nair' }));
    expect(screen.queryByRole('menuitem', { name: 'Send invitation again' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Reset two-factor' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Disable' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable Meera Nair?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(
      await within(dialog).findByText('At least one admin user must keep the administrator role'),
    ).toBeTruthy();
  });

  it('resets another admin’s two-factor after confirming', async () => {
    const requests = mockApi({
      ...adminUsersApi(['admin_user.view', 'admin_user.manage']),
      [`POST /access/admin-users/${MEERA.id}/two-factor/reset`]: () =>
        new Response(null, { status: 204 }),
    });
    renderApp('/admin-users');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Meera Nair' }));
    await user.click(screen.getByRole('menuitem', { name: 'Reset two-factor' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Reset two-factor for Meera Nair?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Reset two-factor' }));
    await waitFor(() => {
      expect(requests.some((r) => r.path.endsWith('/two-factor/reset'))).toBe(true);
    });
  });
});

describe('accepting an admin invitation', () => {
  const TOKEN = 'A'.repeat(43);

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('reads the token from the fragment, clears it, and sets the password without signing in', async () => {
    window.history.replaceState(null, '', `/accept-invitation#token=${TOKEN}`);
    const requests = mockApi({
      'GET /auth/me': () => problem(401, 'not_signed_in', 'Sign in to continue'),
      'POST /auth/invitation': () =>
        json({
          invitation: {
            email: 'ravi@example.com',
            displayName: 'Ravi Pillai',
            expiresAt: '2026-11-07T09:00:00.000Z',
          },
        }),
      'POST /auth/accept-invitation': () => json({ email: 'ravi@example.com' }),
    });
    renderApp('/accept-invitation');
    expect(await screen.findByRole('heading', { name: 'Welcome, Ravi Pillai' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'periyar river at dawn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('heading', { name: 'Your password is set' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
    const accept = requests.find((r) => r.path === '/auth/accept-invitation');
    expect(accept?.body).toEqual({ token: TOKEN, password: 'periyar river at dawn' });
    // The token goes in bodies only, never a URL.
    expect(requests.every((r) => !r.query.toString().includes(TOKEN))).toBe(true);
  });

  it('says a used or expired link cannot be used', async () => {
    window.history.replaceState(null, '', `/accept-invitation#token=${TOKEN}`);
    mockApi({
      'GET /auth/me': () => problem(401, 'not_signed_in', 'Sign in to continue'),
      'POST /auth/invitation': () =>
        problem(404, 'invitation_invalid', 'This invitation link is not valid', {
          detail:
            'It may have been used already or expired. Ask an administrator to send it again.',
        }),
    });
    renderApp('/accept-invitation');
    expect(
      await screen.findByRole('heading', { name: 'This invitation can’t be used' }),
    ).toBeTruthy();
    expect(screen.getByText('This invitation link is not valid')).toBeTruthy();
  });
});
