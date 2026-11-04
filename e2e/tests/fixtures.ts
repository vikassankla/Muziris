import { test as base, expect, type Page } from '@playwright/test';
import type { Database } from '@muziris/db';
import { ADMIN_URL, PASSWORD, STOREFRONT_URL } from '../src/env.js';
import { openWorld } from '../src/world.js';

/** Where admin.setup.ts keeps the signed-in admin's cookies; .gitignore leaves it out. */
export const ADMIN_STATE = '.auth/admin.json';

/**
 * Collects what the browser refuses under the apps' content security policies, so a journey
 * fails when a change needs something the policy does not allow.
 */
export function policyViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
      violations.push(message.text());
    }
  });
  return violations;
}

interface Fixtures {
  /** A page in the admin app, signed in as the administrator. */
  admin: Page;
  /** The storefront, signed out. */
  shop: Page;
}

export const test = base.extend<Fixtures, { db: Database }>({
  db: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from this argument.
    async ({}, use) => {
      const handle = openWorld();
      await use(handle.db);
      await handle.close();
    },
    { scope: 'worker' },
  ],
  admin: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: ADMIN_URL, storageState: ADMIN_STATE });
    const page = await context.newPage();
    const violations = policyViolations(page);
    await use(page);
    await context.close();
    expect(violations, 'content security policy violations').toEqual([]);
  },
  shop: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: STOREFRONT_URL });
    const page = await context.newPage();
    const violations = policyViolations(page);
    await use(page);
    await context.close();
    expect(violations, 'content security policy violations').toEqual([]);
  },
});

export { expect };

/** Signs a buyer in to the storefront with the test password. */
export async function signInBuyer(shop: Page, email: string): Promise<void> {
  await shop.goto('/sign-in');
  await shop.getByLabel('Work email').fill(email);
  await shop.getByLabel('Password').fill(PASSWORD);
  await shop.getByRole('button', { name: 'Sign in' }).click();
  await expect(shop).not.toHaveURL(/\/sign-in/);
}

/**
 * Puts lines through quick order and opens checkout, each line as "SKU, quantity". Quick order
 * hands its lines over in memory (ADR 0018), so a reload of checkout loses them: call this again.
 */
export async function quickOrderCheckout(shop: Page, lines: readonly string[]): Promise<void> {
  await shop.goto('/quick-order');
  await shop.getByLabel('Items').fill(lines.join('\n'));
  await shop.getByRole('button', { name: /check/i }).click();
  await shop.getByRole('button', { name: 'Go to checkout' }).click();
  await expect(shop.getByRole('heading', { name: 'Checkout' })).toBeVisible();
}
