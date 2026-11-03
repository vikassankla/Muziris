import { findProductBySku } from '@muziris/catalog';
import { BEARING, contractPrice, makeCustomer } from '../src/world.js';
import { expect, quickOrderCheckout, signInBuyer, test } from './fixtures.js';

// Journey 2 (ADR 0024): the list price, the tier price at 100, then the customer's contract
// price, with totals that match the checkout known answers.
test('prices and tiers', async ({ shop, db }) => {
  const customer = await makeCustomer(db, { name: 'Sahyadri Motors', buyer: true });
  await signInBuyer(shop, customer.email);

  // 99 at the ₹450.00 list price: 52,864.00 (known answer "one short of the tier").
  await quickOrderCheckout(shop, [`${BEARING.sku}, 99`]);
  await expect(shop.getByRole('cell', { name: '₹450.00', exact: true })).toBeVisible();
  await expect(shop.getByRole('button', { name: 'Place order · ₹52,864.00' })).toBeVisible();

  // 100 reach the ₹410.00 tier: 48,675.00 (known answer "within the state, at the 100 tier").
  await quickOrderCheckout(shop, [`${BEARING.sku}, 100`]);
  await expect(shop.getByRole('cell', { name: '₹410.00', exact: true })).toBeVisible();
  await expect(shop.getByRole('button', { name: 'Place order · ₹48,675.00' })).toBeVisible();

  // A contract price of ₹400.00 for this customer comes before the list price. 10 × 400.00 =
  // 4,000.00 and 250.00 shipping. CGST and SGST at 9% on each: 360.00 + 22.50 = 382.50, twice.
  // Total 4,000.00 + 250.00 + 765.00 = 5,015.00.
  const bearing = await findProductBySku(db, BEARING.sku);
  if (!bearing) throw new Error('The world has no bearing');
  await contractPrice(db, customer.id, bearing, '400.00');
  await quickOrderCheckout(shop, [`${BEARING.sku}, 10`]);
  await expect(shop.getByRole('cell', { name: '₹400.00', exact: true })).toBeVisible();
  await expect(shop.getByRole('button', { name: 'Place order · ₹5,015.00' })).toBeVisible();
});
