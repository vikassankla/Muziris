import { createBuyerRole, listBuyerRoles, type NewBuyerRole } from '@muziris/access';
import { createProductUnit, listProductUnits, type NewProductUnit } from '@muziris/catalog';
import type { Database } from '@muziris/db';
import {
  createOrganization,
  findOrganization,
  getSetting,
  setSetting,
  type Organization,
} from '@muziris/platform';
import { DEFAULT_BUYER_ROLE } from './settings.js';

// First-run setup (ADR 0021): the organization, the standard product units and buyer roles, and
// the default buyer role. Every step runs only when its result is missing, so running it again
// changes nothing.

/** The product units most catalogues start with; an admin adds others in the admin app. */
export const STANDARD_PRODUCT_UNITS: readonly NewProductUnit[] = [
  { code: 'each', name: 'Each', precision: 0 },
  { code: 'pack', name: 'Pack', precision: 0 },
  { code: 'kg', name: 'Kilogram', precision: 3 },
  { code: 'm', name: 'Metre', precision: 3 },
  { code: 'l', name: 'Litre', precision: 3 },
];

/** The code of the standard role invited buyers get unless the admin picks another. */
export const BUYER_ROLE_CODE = 'buyer';

/**
 * The buyer roles a business starts with. They are ordinary roles: an admin may change or
 * delete them. Neither reaches a customer's subsidiaries.
 */
export const STANDARD_BUYER_ROLES: readonly NewBuyerRole[] = [
  {
    code: BUYER_ROLE_CODE,
    name: 'Buyer',
    description: "Orders for the customer, and sees the customer's orders and addresses",
    grants: [
      { permission: 'order.view', accessLevel: 'my_customer' },
      { permission: 'order.place', accessLevel: 'my_customer' },
      { permission: 'shopping_list.view', accessLevel: 'own_records' },
      { permission: 'shopping_list.manage', accessLevel: 'own_records' },
      { permission: 'rfq.view', accessLevel: 'own_records' },
      { permission: 'rfq.create', accessLevel: 'my_customer' },
      { permission: 'quote.view', accessLevel: 'own_records' },
      { permission: 'quote.accept', accessLevel: 'own_records' },
      { permission: 'address.view', accessLevel: 'my_customer' },
    ],
  },
  {
    code: 'purchasing_admin',
    name: 'Purchasing admin',
    description: 'Everything a buyer does for the customer, plus its addresses and buyer users',
    grants: [
      { permission: 'order.view', accessLevel: 'my_customer' },
      { permission: 'order.place', accessLevel: 'my_customer' },
      { permission: 'shopping_list.view', accessLevel: 'my_customer' },
      { permission: 'shopping_list.manage', accessLevel: 'my_customer' },
      { permission: 'rfq.view', accessLevel: 'my_customer' },
      { permission: 'rfq.create', accessLevel: 'my_customer' },
      { permission: 'quote.view', accessLevel: 'my_customer' },
      { permission: 'quote.accept', accessLevel: 'my_customer' },
      { permission: 'address.view', accessLevel: 'my_customer' },
      { permission: 'address.manage', accessLevel: 'my_customer' },
      { permission: 'buyer_user.view', accessLevel: 'my_customer' },
      { permission: 'buyer_user.manage', accessLevel: 'my_customer' },
    ],
  },
];

export interface SetupResult {
  organization: Organization;
  /** False when the install already had its organization. */
  organizationCreated: boolean;
  /** Codes of the units this run added. */
  unitsAdded: string[];
  /** Codes of the buyer roles this run added. */
  buyerRolesAdded: string[];
  /** True when this run made the Buyer role the organization's default buyer role. */
  defaultBuyerRoleSet: boolean;
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export async function runSetup(
  db: Database,
  input: { organizationName?: string | undefined },
): Promise<SetupResult> {
  let organization = await findOrganization(db);
  const organizationCreated = organization === undefined;
  if (!organization) {
    if (input.organizationName === undefined || input.organizationName.trim() === '') {
      throw new SetupError('This install has no organization yet: pass --organization "<name>"');
    }
    organization = await createOrganization(db, input.organizationName);
  }
  const existing = new Set((await listProductUnits(db)).map((unit) => unit.code));
  const unitsAdded: string[] = [];
  for (const unit of STANDARD_PRODUCT_UNITS) {
    if (existing.has(unit.code)) continue;
    await createProductUnit(db, unit);
    unitsAdded.push(unit.code);
  }

  const roles = new Set((await listBuyerRoles(db, { limit: 200 })).buyerRoles.map((r) => r.code));
  const buyerRolesAdded: string[] = [];
  let buyerRoleId: string | undefined;
  for (const role of STANDARD_BUYER_ROLES) {
    if (roles.has(role.code)) continue;
    const created = await createBuyerRole(db, role);
    if (created.code === BUYER_ROLE_CODE) buyerRoleId = created.id;
    buyerRolesAdded.push(role.code);
  }

  // Only with a Buyer role this run created: on a later run, an admin's own choice of default,
  // or of none, stays.
  let defaultBuyerRoleSet = false;
  if (buyerRoleId !== undefined) {
    const scope = { organizationId: organization.id };
    if ((await getSetting(db, DEFAULT_BUYER_ROLE, scope)).value === null) {
      await setSetting(
        db,
        DEFAULT_BUYER_ROLE,
        { type: 'organization', id: organization.id },
        buyerRoleId,
      );
      defaultBuyerRoleSet = true;
    }
  }
  return { organization, organizationCreated, unitsAdded, buyerRolesAdded, defaultBuyerRoleSet };
}
