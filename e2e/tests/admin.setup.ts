import { test as setup, expect } from '@playwright/test';
import { base32Decode, totpCode } from '@muziris/identity';
import { ADMIN_EMAIL, ADMIN_URL, PASSWORD } from '../src/env.js';
import { ADMIN_STATE } from './fixtures.js';

// Signs the administrator in once for every journey: sign-in is rate limited per address. The
// run's database is new, so this is the admin's first sign-in and enrols the authenticator
// app (ADR 0026), reading the setup key off the page as an app would from the QR code.
setup('the administrator signs in and sets up two-factor sign-in', async ({ page }) => {
  await page.goto(`${ADMIN_URL}/sign-in`);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.getByLabel('Setup key', { exact: true }).textContent()) ?? '';
  await page.getByLabel('Authentication code').fill(totpCode(base32Decode(secret), new Date()));
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem'),
  ).toHaveCount(10);
  await page.getByLabel('I have saved these codes somewhere safe').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await page.context().storageState({ path: ADMIN_STATE });
});
