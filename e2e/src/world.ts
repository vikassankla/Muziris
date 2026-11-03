// The data the journeys share and the data each test makes for itself (ADR 0024). Everything is
// made through the modules' own functions; the browser is only for the journey under test.
//
// The rates are test values, not tax advice: 18% on HSN 8482 and 5% on HSN 4015, sold from
// Maharashtra. The prices and totals match the checkout known answers
// (apps/api/src/checkout-known-answers.integration.test.ts).

import { randomUUID } from 'node:crypto';
import { assignBuyerRole, listBuyerRoles } from '@muziris/access';
import { createProduct, type Product } from '@muziris/catalog';
import { addAddress, createCustomer, linkBuyerUser } from '@muziris/customers';
import { createDatabase, type Database } from '@muziris/db';
import { createUser, findUserByEmail } from '@muziris/identity';
import { SHIPPING_FLAT_RATE } from '@muziris/orders';
import {
  createWebsite,
  findOrganization,
  listWebsites,
  setSetting,
  type Website,
} from '@muziris/platform';
import {
  addPrice,
  createAssignment,
  createPriceList,
  rebuildCombinedPrices,
} from '@muziris/pricing';
import { rebuildSearchIndex } from '@muziris/search';
import { addGstRate, setGstRegistration } from '@muziris/tax';
import { rebuildVisibility } from '@muziris/visibility';
import { ADMIN_EMAIL, e2eDatabaseUrl, PASSWORD, WEBSITE_CODE } from './env.js';

export const BEARING = { sku: 'BRG-6205-2RS', name: 'Deep groove ball bearing 6205-2RS' };
export const GLOVES = { sku: 'GLV-NITRILE-L', name: 'Nitrile gloves, large' };
/** Ordered from a shopping list, then disabled (catalog-changes.spec.ts). */
export const SEAL = { sku: 'SEAL-TC-35', name: 'Oil seal TC 35x52x7' };

async function product(db: Database, sku: string, name: string, hsnSacCode: string) {
  return createProduct(db, {
    sku,
    name,
    status: 'enabled',
    attributes: {},
    primaryUnitCode: 'each',
    hsnSacCode,
  });
}

async function website(db: Database): Promise<Website> {
  const organization = await findOrganization(db);
  if (!organization) throw new Error('Run setup before seeding the world');
  return createWebsite(db, {
    organizationId: organization.id,
    code: WEBSITE_CODE,
    name: 'Muziris Industrial',
    countryCode: 'IN',
    defaultCurrency: 'INR',
    defaultLocale: 'en-IN',
    timeZone: 'Asia/Kolkata',
  });
}

async function adminId(db: Database): Promise<string> {
  const admin = await findUserByEmail(db, 'admin', ADMIN_EMAIL);
  if (!admin) throw new Error('Run admin:create before seeding the world');
  return admin.id;
}

/** The Indian website, its tax tables, three products and their list prices. */
export async function seedWorld(db: Database): Promise<void> {
  const site = await website(db);
  const bearing = await product(db, BEARING.sku, BEARING.name, '84821011');
  const gloves = await product(db, GLOVES.sku, GLOVES.name, '40151900');
  const seal = await product(db, SEAL.sku, SEAL.name, '84829900');

  const list = await createPriceList(db, { name: 'List price', currency: 'INR' });
  for (const [item, minQuantity, amount] of [
    [bearing, '1', '450.00'],
    [bearing, '100', '410.00'],
    [gloves, '1', '95.50'],
    [seal, '1', '120.00'],
  ] as const) {
    await addPrice(db, list.id, { productId: item.id, unitCode: 'each', minQuantity, amount });
  }
  await createAssignment(db, { priceListId: list.id, websiteId: site.id, target: 'website' });
  await setSetting(db, SHIPPING_FLAT_RATE, { type: 'website', id: site.id }, { amount: '250.00' });

  const by = await adminId(db);
  await setGstRegistration(db, site.id, { gstin: '27AAPFU0939F1ZV' });
  await addGstRate(db, by, { codePrefix: '8482', ratePercent: '18', validFrom: '2025-04-01' });
  await addGstRate(db, by, { codePrefix: '4015', ratePercent: '5', validFrom: '2025-04-01' });

  await rebuildAll(db);
}

/** The price, visibility and search builds, as an admin's "Build now" runs them. */
export async function rebuildAll(db: Database): Promise<void> {
  await rebuildCombinedPrices(db);
  await rebuildVisibility(db);
  await rebuildSearchIndex(db);
}

/** Opens the journeys' database for one worker. */
export function openWorld() {
  return createDatabase({
    url: e2eDatabaseUrl(),
    maxConnections: 2,
    applicationName: 'muziris-e2e',
  });
}

export async function findWebsite(db: Database): Promise<Website> {
  const organization = await findOrganization(db);
  const found = organization
    ? (await listWebsites(db, organization.id)).find((w) => w.code === WEBSITE_CODE)
    : undefined;
  if (!found) throw new Error('The world has no website; did prepare run?');
  return found;
}

export interface TestCustomer {
  id: string;
  name: string;
  /** A buyer's email for this customer, unique to the test. */
  email: string;
  /** The buyer user's id, when the test made one rather than inviting them. */
  buyerUserId?: string;
}

/**
 * A customer of its own for one test, with a Pune address for billing and shipping. With a
 * buyer, also a buyer user with the Buyer role and the test password, ready to sign in.
 */
export async function makeCustomer(
  db: Database,
  options: { name: string; buyer: boolean },
): Promise<TestCustomer> {
  const tag = randomUUID().slice(0, 8);
  const name = `${options.name} ${tag}`;
  const email = `buyer-${tag}@e2e.example`;
  const customer = await createCustomer(db, { name });
  await addAddress(db, {
    customerId: customer.id,
    label: 'Pune plant',
    countryCode: 'IN',
    line1: 'Plot 12, MIDC Bhosari',
    city: 'Pune',
    regionCode: '27',
    postalCode: '411026',
    isDefaultBilling: true,
    isDefaultShipping: true,
  });
  if (!options.buyer) return { id: customer.id, name, email };

  const user = await createUser(db, {
    realm: 'buyer',
    email,
    displayName: `Priya ${tag}`,
    password: PASSWORD,
  });
  await linkBuyerUser(db, customer.id, email);
  const roles = await listBuyerRoles(db, { limit: 50 });
  const buyerRole = roles.buyerRoles.find((r) => r.code === 'buyer');
  if (!buyerRole) throw new Error('setup did not add the Buyer role');
  await assignBuyerRole(db, user.id, buyerRole.id);
  return { id: customer.id, name, email, buyerUserId: user.id };
}

/** A contract price list for one customer, ahead of the website's list price. */
export async function contractPrice(
  db: Database,
  customerId: string,
  item: Product | { id: string },
  amount: string,
): Promise<void> {
  const site = await findWebsite(db);
  const list = await createPriceList(db, {
    name: `Contract ${customerId.slice(0, 8)}`,
    currency: 'INR',
  });
  await addPrice(db, list.id, { productId: item.id, unitCode: 'each', minQuantity: '1', amount });
  await createAssignment(db, {
    priceListId: list.id,
    websiteId: site.id,
    target: 'customer',
    targetId: customerId,
  });
  await rebuildCombinedPrices(db);
}

/**
 * A product of its own for one test, with a list price, and the builds that let buyers see it.
 * The builds are for the whole catalog: call it only from catalog-changes.spec.ts.
 */
export async function makeProduct(
  db: Database,
  input: { sku: string; name: string; hsnSacCode: string; amount: string },
): Promise<Product> {
  const site = await findWebsite(db);
  const made = await product(db, input.sku, input.name, input.hsnSacCode);
  const list = await createPriceList(db, { name: `List ${input.sku}`, currency: 'INR' });
  await addPrice(db, list.id, {
    productId: made.id,
    unitCode: 'each',
    minQuantity: '1',
    amount: input.amount,
  });
  await createAssignment(db, { priceListId: list.id, websiteId: site.id, target: 'website' });
  await rebuildAll(db);
  return made;
}
