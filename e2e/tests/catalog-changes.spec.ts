import { findProductBySku, updateProduct } from '@muziris/catalog';
import { rebuildVisibility } from '@muziris/visibility';
import { randomUUID } from 'node:crypto';
import { BEARING, makeCustomer, makeProduct, SEAL } from '../src/world.js';
import { expect, quickOrderCheckout, signInBuyer, test } from './fixtures.js';

// These journeys change what buyers see, and a visibility build is for the whole catalog, so
// they run one at a time; the other journeys never build visibility.
test.describe.configure({ mode: 'serial' });

// Journey 4 (ADR 0024): a new product stays hidden from buyers until a visibility build, and the
// admin app says so.
test('catalog changes reach buyers', async ({ admin, shop, db }) => {
  const customer = await makeCustomer(db, { name: 'Deccan Pumps', buyer: true });
  const sku = `PIN-${randomUUID().slice(0, 6).toUpperCase()}`;
  const name = `Taper pin ${sku}`;

  await admin.goto('/products');
  await admin.getByRole('button', { name: 'New product' }).click();
  await admin.getByLabel('SKU').fill(sku);
  await admin.getByLabel('Name').fill(name);
  await admin.getByLabel('Primary product unit').click();
  await admin.getByRole('option', { name: 'Each' }).click();
  await admin.getByRole('switch').click();
  await admin.getByRole('button', { name: 'Create product' }).click();
  await expect(admin.getByRole('heading', { name })).toBeVisible();

  await admin.goto('/products');
  await expect(admin.getByText('Buyers do not see catalog changes yet')).toBeVisible();

  await signInBuyer(shop, customer.email);
  await shop.goto(`/search?q=${encodeURIComponent(sku)}`);
  await expect(shop.getByText(`No results for “${sku}”`)).toBeVisible();

  await admin.getByRole('button', { name: 'Build visibility now' }).click();
  await expect(admin.getByText('Buyers do not see catalog changes yet')).toBeHidden();

  await shop.reload();
  await expect(shop.getByRole('link', { name })).toBeVisible();
});

// Journey 3 (ADR 0024): a buyer saves a shopping list, a product on it is withdrawn, and the
// buyer orders the rest from the list.
test('shopping list reorder', async ({ shop, db }) => {
  const customer = await makeCustomer(db, { name: 'Malabar Textiles', buyer: true });
  const listName = `Monthly MRO ${randomUUID().slice(0, 6)}`;
  await signInBuyer(shop, customer.email);

  await shop.goto('/quick-order');
  await shop.getByLabel('Items').fill(`${BEARING.sku}, 10\n${SEAL.sku}, 4`);
  await shop.getByRole('button', { name: /check/i }).click();
  await shop.getByLabel('Shopping list').selectOption({ label: 'New list…' });
  await shop.getByLabel('List name').fill(listName);
  await shop.getByRole('button', { name: 'Add to shopping list' }).click();
  await expect(shop.getByRole('heading', { name: listName })).toBeVisible();
  await expect(shop.getByRole('link', { name: SEAL.name })).toBeVisible();

  const seal = await findProductBySku(db, SEAL.sku);
  if (!seal) throw new Error('The world has no seal');
  await updateProduct(db, seal.id, { status: 'disabled' });
  await rebuildVisibility(db);
  try {
    await shop.reload();
    await expect(shop.getByText('You can no longer order this product.')).toBeVisible();
    await expect(shop.getByText('Unavailable lines are left out at checkout.')).toBeVisible();

    await shop.getByRole('link', { name: 'Check out this list' }).click();
    await expect(shop.getByRole('heading', { name: 'Checkout' })).toBeVisible();
    await expect(shop.getByRole('cell', { name: BEARING.name })).toBeVisible();
    await expect(shop.getByRole('cell', { name: SEAL.name })).toHaveCount(0);
    // As in journey 1: 10 bearings, 5,605.00 with shipping and GST.
    await shop.getByRole('button', { name: 'Place order · ₹5,605.00' }).click();
    await expect(shop.getByText(/Order placed/)).toBeVisible();
  } finally {
    await updateProduct(db, seal.id, { status: 'enabled' });
    await rebuildVisibility(db);
  }
});

// Journey 5 (ADR 0024): a product whose HSN code no GST rate covers cannot be ordered; the Tax
// screen names the code, the admin adds the rate, and checkout goes through.
test('tax readiness', async ({ admin, shop, db }) => {
  const customer = await makeCustomer(db, { name: 'Konkan Packaging', buyer: true });
  // A code of its own each run, so no rate covers it yet.
  const code = `39${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const tape = await makeProduct(db, {
    sku: `TAPE-${code}`,
    name: `PTFE thread tape ${code}`,
    hsnSacCode: code,
    amount: '40.00',
  });

  await signInBuyer(shop, customer.email);
  await quickOrderCheckout(shop, [`${tape.sku}, 10`]);
  await expect(shop.getByText(`No GST rate covers ${code}`)).toBeVisible();
  await expect(shop.getByRole('button', { name: /^Place order/ })).toBeDisabled();

  await admin.goto('/tax');
  await expect(
    admin.getByText('Checkout refuses orders on this website until these are fixed.'),
  ).toBeVisible();
  const item = admin.getByText('Codes in use that no GST rate covers today');
  await expect(item).toBeVisible();
  await expect(admin.getByText(code)).toBeVisible();
  await admin.getByRole('button', { name: 'Add a rate' }).click();
  await admin.getByRole('button', { name: 'Add rate' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Add a GST rate' });
  await dialog.getByLabel('HSN or SAC prefix').fill(code);
  await dialog.getByLabel('Rate (%)').fill('18');
  await dialog.getByLabel('First day').fill('2025-04-01');
  await dialog.getByRole('button', { name: 'Add rate' }).click();
  await expect(dialog).toBeHidden();
  await admin.getByRole('tab', { name: /Readiness/ }).click();
  await expect(admin.getByText('A GST rate covers every code in use today')).toBeVisible();

  // 10 × 40.00 = 400.00 and 250.00 shipping, 9% CGST and 9% SGST on each: 36.00 and 22.50 twice.
  // Total 400.00 + 250.00 + 117.00 = 767.00.
  await quickOrderCheckout(shop, [`${tape.sku}, 10`]);
  await shop.getByRole('button', { name: 'Place order · ₹767.00' }).click();
  await expect(shop).toHaveURL(/\/orders\/[^/]+$/);
});
