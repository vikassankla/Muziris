import { createProductUnit, listProductUnits, type NewProductUnit } from '@muziris/catalog';
import type { Database } from '@muziris/db';
import { createOrganization, findOrganization, type Organization } from '@muziris/platform';

// First-run setup (ADR 0021): the organization and the standard product units. Every step runs
// only when its result is missing, so running it again changes nothing.

/** The product units most catalogues start with; an admin adds others in the admin app. */
export const STANDARD_PRODUCT_UNITS: readonly NewProductUnit[] = [
  { code: 'each', name: 'Each', precision: 0 },
  { code: 'pack', name: 'Pack', precision: 0 },
  { code: 'kg', name: 'Kilogram', precision: 3 },
  { code: 'm', name: 'Metre', precision: 3 },
  { code: 'l', name: 'Litre', precision: 3 },
];

export interface SetupResult {
  organization: Organization;
  /** False when the install already had its organization. */
  organizationCreated: boolean;
  /** Codes of the units this run added. */
  unitsAdded: string[];
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
  return { organization, organizationCreated, unitsAdded };
}
