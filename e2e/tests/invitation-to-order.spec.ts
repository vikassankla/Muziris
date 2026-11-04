import { PASSWORD, STOREFRONT_URL } from '../src/env.js';
import { linkIn, waitForEmail } from '../src/mailpit.js';
import { BEARING, makeCustomer } from '../src/world.js';
import { expect, quickOrderCheckout, test } from './fixtures.js';

// Journey 1 (ADR 0024): an admin invites a buyer, who sets a password, orders on payment terms
// and gets the order email; the admin confirms the order and finds it on the customer, then
// finds the buyer by name on its Buyer users tab, with the role the invitation gave and a sign-in.
test('invitation to order', async ({ admin, shop, db }) => {
  const customer = await makeCustomer(db, { name: 'Kaveri Engineering', buyer: false });

  await admin.goto(`/customers/${customer.id}`);
  await admin.getByRole('button', { name: 'Invite a buyer user' }).first().click();
  const invite = admin.getByRole('dialog', { name: 'Invite a buyer user' });
  await invite.getByLabel('Email').fill(customer.email);
  await invite.getByLabel('Name').fill('Priya Nair');
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(invite).toBeHidden();

  const invitation = await waitForEmail(customer.email, /invit/i);
  await shop.goto(linkIn(invitation.text, `${STOREFRONT_URL}/accept-invitation`));
  await expect(shop.getByRole('heading', { name: 'Welcome, Priya Nair' })).toBeVisible();
  await shop.getByLabel('Password').fill(PASSWORD);
  await shop.getByRole('button', { name: 'Create account and sign in' }).click();
  await expect(shop).not.toHaveURL(/accept-invitation|sign-in/);

  await quickOrderCheckout(shop, [`${BEARING.sku}, 10`]);
  await expect(shop.getByRole('cell', { name: BEARING.name })).toBeVisible();
  // 10 × 450.00 = 4,500.00, shipping 250.00, CGST and SGST at 9% on both: 427.50 twice.
  await shop.getByRole('button', { name: 'Place order · ₹5,605.00' }).click();
  await expect(shop).toHaveURL(/\/orders\/[^/]+$/);
  const number = decodeURIComponent(shop.url().split('/').at(-1) ?? '');
  await expect(shop.getByRole('heading', { name: `Order ${number}` })).toBeVisible();

  await waitForEmail(customer.email, /order/i);

  await admin.goto(`/customers/${customer.id}`);
  await admin.getByRole('tab', { name: /orders/i }).click();
  await admin.getByRole('link', { name: number }).click();
  await admin.getByRole('button', { name: /confirm/i }).click();
  await expect(admin.getByText(/confirmed the order/)).toBeVisible();

  await admin.goto(`/customers/${customer.id}?tab=buyer-users`);
  const buyer = admin.getByRole('row', { name: /Priya Nair/ });
  await expect(buyer.getByRole('cell').nth(1)).toHaveText(customer.email);
  await expect(buyer.getByRole('cell').nth(2)).toHaveText('Buyer');
  await expect(buyer.getByRole('cell').nth(3)).toHaveText('Active');
  await expect(buyer.getByRole('cell').nth(4)).not.toHaveText('Never');
});
