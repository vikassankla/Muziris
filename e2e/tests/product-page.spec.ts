import { randomUUID } from 'node:crypto';
import { BEARING, makeCustomer } from '../src/world.js';
import { expect, signInBuyer, test } from './fixtures.js';

// Journey 6, from the hand test (status item 16): a buyer adds a product to a new shopping list
// from its page, then orders it from the same page.
test('order and save from the product page', async ({ shop, db }) => {
  const customer = await makeCustomer(db, { name: 'Periyar Spices', buyer: true });
  const listName = `Spares ${randomUUID().slice(0, 6)}`;
  await signInBuyer(shop, customer.email);

  await shop.goto(`/p/${encodeURIComponent(BEARING.sku)}`);
  await expect(shop.getByRole('heading', { name: BEARING.name })).toBeVisible();
  await shop.getByLabel('Quantity').fill('10');
  await shop.getByLabel('Shopping list').selectOption({ label: 'New list…' });
  await shop.getByLabel('List name').fill(listName);
  await shop.getByRole('button', { name: 'Add to shopping list' }).click();
  await expect(shop.getByRole('status')).toContainText(`Added to ${listName}.`);

  await shop.getByRole('link', { name: 'View list' }).click();
  await expect(shop.getByRole('heading', { name: listName })).toBeVisible();
  await expect(shop.getByRole('link', { name: BEARING.name })).toBeVisible();

  await shop.getByRole('link', { name: BEARING.name }).click();
  await expect(shop.getByRole('heading', { name: BEARING.name })).toBeVisible();
  await shop.getByLabel('Quantity').fill('10');
  await shop.getByRole('button', { name: 'Order now' }).click();
  await expect(shop.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await expect(shop.getByRole('cell', { name: BEARING.name })).toBeVisible();
  // As in journey 1: 10 bearings, 5,605.00 with shipping and GST.
  await shop.getByRole('button', { name: 'Place order · ₹5,605.00' }).click();
  await expect(shop).toHaveURL(/\/orders\/[^/]+$/);
  const number = decodeURIComponent(shop.url().split('/').at(-1) ?? '');
  await expect(shop.getByRole('heading', { name: `Order ${number}` })).toBeVisible();
});
