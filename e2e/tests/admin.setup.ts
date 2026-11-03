import { test as setup, expect } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_URL, PASSWORD } from '../src/env.js';
import { ADMIN_STATE } from './fixtures.js';

// Signs the administrator in once for every journey: sign-in is rate limited per address.
setup('the administrator signs in', async ({ page }) => {
  await page.goto(`${ADMIN_URL}/sign-in`);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await page.context().storageState({ path: ADMIN_STATE });
});
