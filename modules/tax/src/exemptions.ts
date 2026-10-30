import { findCustomer, isUsStateCode } from '@muziris/customers';
import type { Database } from '@muziris/db';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { exemptions } from './db/schema.js';
import { isUniqueViolation, TaxError } from './errors.js';

// US sales tax exemption certificates (ADR 0017): a customer that resells, or is otherwise
// exempt, gives the seller a certificate for each state. A valid one makes an order shipped to
// that state tax free, and the order keeps the certificate number.

export interface Exemption {
  id: string;
  customerId: string;
  stateCode: string;
  certificateNumber: string;
  expiresOn: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export const newExemptionSchema = z.object({
  customerId: z.uuid(),
  stateCode: z.string().trim().toUpperCase().refine(isUsStateCode, 'Not a US state code'),
  certificateNumber: z.string().trim().min(1).max(64),
  expiresOn: z.iso.date().nullable().default(null),
});

export async function addExemption(
  db: Database,
  adminUserId: string,
  input: z.input<typeof newExemptionSchema>,
): Promise<Exemption> {
  const values = newExemptionSchema.parse(input);
  const actor = z.uuid().parse(adminUserId);
  if (!(await findCustomer(db, values.customerId))) {
    throw new TaxError('customer_not_found', 'No such customer');
  }
  try {
    const [row] = await db
      .insert(exemptions)
      .values({ ...values, createdBy: actor, updatedBy: actor })
      .returning();
    if (!row) throw new Error('Exemption insert returned no row');
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'tax_exemption_customer_state_uq')) {
      throw new TaxError(
        'exemption_taken',
        'The customer already has a certificate for this state; remove it first',
      );
    }
    throw error;
  }
}

export async function listExemptions(
  db: Pick<Database, 'select'>,
  query: { customerId?: string } = {},
): Promise<Exemption[]> {
  const customerId = query.customerId === undefined ? undefined : z.uuid().parse(query.customerId);
  return db
    .select()
    .from(exemptions)
    .where(and(customerId === undefined ? undefined : eq(exemptions.customerId, customerId)))
    .orderBy(asc(exemptions.customerId), asc(exemptions.stateCode));
}

export async function deleteExemption(db: Database, exemptionId: string): Promise<void> {
  const id = z.uuid().safeParse(exemptionId);
  const deleted = id.success
    ? await db.delete(exemptions).where(eq(exemptions.id, id.data)).returning({ id: exemptions.id })
    : [];
  if (deleted.length === 0) throw new TaxError('exemption_not_found', 'No such exemption');
}
