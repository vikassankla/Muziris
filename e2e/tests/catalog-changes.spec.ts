import { createCategory, findProductBySku, updateProduct } from '@muziris/catalog';
import { createCustomerGroup, setCustomerGroup } from '@muziris/customers';
import { rebuildVisibility } from '@muziris/visibility';
import { randomUUID } from 'node:crypto';
import { BEARING, makeCustomer, makeProduct, SEAL } from '../src/world.js';
import { STOREFRONT_URL } from '../src/env.js';
import { expect, quickOrderCheckout, signInBuyer, test } from './fixtures.js';

// These journeys change what buyers see, and a visibility build is for the whole catalog, so
// they run one at a time; the other journeys never build visibility.
test.describe.configure({ mode: 'serial' });

// Journey 4 (ADR 0024): a new product reaches buyers through the visibility build its creation
// queued (ADR 0025), and until then the admin app says a build is coming.
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
  await expect(
    admin.getByText('A visibility build is queued and starts within seconds.'),
  ).toBeVisible();

  await signInBuyer(shop, customer.email);
  await shop.goto(`/search?q=${encodeURIComponent(sku)}`);
  await expect(shop.getByText(`No results for “${sku}”`)).toBeVisible();

  // The build waits 15 seconds to gather a burst of edits, then runs; nobody presses anything.
  await expect(admin.getByText('Buyers do not see catalog changes yet')).toBeHidden({
    timeout: 40_000,
  });
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

// Journey 7 (ADR 0027): an admin hides a category from a customer group on the Visibility
// screen; after the build, a buyer in the group no longer finds its product, and a buyer of
// another customer still does. The category, product and group are the test's own.
test('visibility rules narrow a catalog', async ({ admin, shop, browser, db }) => {
  const tag = randomUUID().slice(0, 6);
  const category = await createCategory(db, { code: `spill_${tag}`, name: `Spill kits ${tag}` });
  const kit = await makeProduct(db, {
    sku: `SPILL-${tag.toUpperCase()}`,
    name: `Oil spill kit ${tag}`,
    hsnSacCode: '8482',
    amount: '900.00',
    categoryId: category.id,
  });
  const group = await createCustomerGroup(db, { code: `dealers_${tag}`, name: `Dealers ${tag}` });
  const dealer = await makeCustomer(db, { name: 'Vembanad Dealers', buyer: true });
  await setCustomerGroup(db, dealer.id, group.id);
  const other = await makeCustomer(db, { name: 'Thrissur Works', buyer: true });

  await admin.goto('/visibility');
  // With no rules yet, the empty state offers New rule too.
  await admin.getByRole('button', { name: 'New rule' }).first().click();
  const sheet = admin.getByRole('dialog', { name: 'New visibility rule' });
  await sheet.getByRole('combobox', { name: 'Rule on' }).click();
  await admin.getByRole('option', { name: 'A category and everything in it' }).click();
  await sheet.getByRole('combobox', { name: 'Category' }).click();
  await admin.getByRole('option', { name: category.name }).click();
  await sheet.getByRole('combobox', { name: 'Customer group' }).click();
  await admin.getByRole('option', { name: group.name }).click();
  await sheet.getByRole('button', { name: 'Create rule' }).click();
  await expect(sheet).toBeHidden();
  await expect(admin.getByRole('row', { name: new RegExp(category.name) })).toContainText(
    group.name,
  );

  // Before the build, the check says the rule waits for it.
  await admin.getByRole('button', { name: 'Check a buyer’s view' }).click();
  const check = admin.getByRole('dialog', { name: 'Check a buyer’s view' });
  await check.getByRole('combobox', { name: 'Customer' }).click();
  await admin.getByRole('option', { name: dealer.name }).click();
  await check.getByLabel('Product').fill(kit.sku);
  await admin.getByRole('button', { name: new RegExp(kit.sku) }).click();
  await check.getByRole('button', { name: 'Check' }).click();
  await expect(
    check.getByText(`Hidden by the rule on ${category.name} for ${group.name}.`),
  ).toBeVisible();
  // The footer's Close; the corner × is named Close too.
  await check.getByText('Close', { exact: true }).click();
  await expect(check).toBeHidden();

  // The rule queued the build; nobody presses anything.
  await expect(admin.getByText(/Buyers do not see .*visibility rule change/)).toBeHidden({
    timeout: 40_000,
  });

  await signInBuyer(shop, dealer.email);
  await shop.goto(`/search?q=${encodeURIComponent(kit.sku)}`);
  await expect(shop.getByText(`No results for “${kit.sku}”`)).toBeVisible();

  const otherContext = await browser.newContext({ baseURL: STOREFRONT_URL });
  try {
    const otherShop = await otherContext.newPage();
    await signInBuyer(otherShop, other.email);
    await otherShop.goto(`/search?q=${encodeURIComponent(kit.sku)}`);
    await expect(otherShop.getByRole('link', { name: kit.name })).toBeVisible();
  } finally {
    await otherContext.close();
  }
});
