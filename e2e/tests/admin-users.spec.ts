import { randomUUID } from 'node:crypto';
import { base32Decode, totpCode } from '@muziris/identity';
import { ADMIN_URL, PASSWORD } from '../src/env.js';
import { linkIn, waitForEmail } from '../src/mailpit.js';
import { expect, policyViolations, test } from './fixtures.js';

// Journey 8 (ADR 0028): the administrator invites an admin, who sets a password from the email
// in Mailpit, signs in and sets up two-factor sign-in; then the administrator disables them and
// their session ends.
test('admin invitation to disabling', async ({ admin, browser }) => {
  const tag = randomUUID().slice(0, 8);
  const email = `admin-${tag}@e2e.example`;
  const name = `Ravi ${tag}`;

  await admin.goto('/admin-users');
  await admin.getByRole('button', { name: 'Invite an admin user' }).click();
  const sheet = admin.getByRole('dialog', { name: 'Invite an admin user' });
  await sheet.getByLabel('Name').fill(name);
  await sheet.getByLabel('Email').fill(email);
  await sheet.getByRole('button', { name: 'Send invitation' }).click();
  await expect(sheet).toBeHidden();
  const row = admin.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('Invited');

  const invitation = await waitForEmail(email, /invited to the .* admin/i);
  const context = await browser.newContext({ baseURL: ADMIN_URL });
  try {
    const page = await context.newPage();
    const violations = policyViolations(page);
    await page.goto(linkIn(invitation.text, `${ADMIN_URL}/accept-invitation`));
    await expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible();
    await expect(page).toHaveURL(/\/accept-invitation$/);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Your password is set' })).toBeVisible();

    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
    const secret = (await page.getByLabel('Setup key', { exact: true }).textContent()) ?? '';
    await page.getByLabel('Authentication code').fill(totpCode(base32Decode(secret), new Date()));
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await page.getByLabel('I have saved these codes somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).not.toHaveURL(/\/sign-in/);

    await admin.reload();
    await expect(row).toContainText('Active');
    await expect(row).toContainText('On');
    await admin.getByRole('button', { name: `Actions for ${name}` }).click();
    await admin.getByRole('menuitem', { name: 'Disable' }).click();
    const confirm = admin.getByRole('alertdialog', { name: `Disable ${name}?` });
    await confirm.getByRole('button', { name: 'Disable' }).click();
    await expect(confirm).toBeHidden();
    await expect(row).toContainText('Disabled');

    // Their session ended: the next page they load sends them to sign in.
    await page.reload();
    await expect(page).toHaveURL(/\/sign-in/);
    expect(violations, 'content security policy violations').toEqual([]);
  } finally {
    await context.close();
  }
});
