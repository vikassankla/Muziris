import type { Database } from '@muziris/db';
import type { TaxProvider, TaxRequest } from '@muziris/orders';
import { and, eq, inArray } from 'drizzle-orm';
import {
  calculateTax,
  TAX_PROVIDER_NAME,
  type RegistrationRow,
  type TaxData,
} from './calculate.js';
import { exemptions, gstRates, registrations, usRates } from './db/schema.js';

// The provider checkout calls (ADR 0017). It loads only the rows that may apply to the request,
// then calculate.ts decides.

/** Every prefix a rate may be entered at for an HSN or SAC code: 2, 4, 6 and 8 digits. */
function prefixesOf(code: string): string[] {
  const prefixes: string[] = [];
  for (let length = 2; length <= code.length; length += 2) prefixes.push(code.slice(0, length));
  return prefixes;
}

async function loadData(db: Database, request: TaxRequest): Promise<TaxData> {
  const regs = await db
    .select({
      regime: registrations.regime,
      regionCode: registrations.regionCode,
      number: registrations.number,
    })
    .from(registrations)
    .where(eq(registrations.websiteId, request.websiteId));
  const registrationRows = regs.filter(
    (r): r is RegistrationRow => r.regime === 'gst' || r.regime === 'us_sales_tax',
  );
  const empty: TaxData = {
    registrations: registrationRows,
    gstRates: [],
    usRates: [],
    exemptions: [],
  };

  if (request.websiteCountryCode === 'IN') {
    const prefixes = [
      ...new Set(request.lines.flatMap((l) => (l.hsnSacCode ? prefixesOf(l.hsnSacCode) : []))),
    ];
    if (prefixes.length === 0) return empty;
    const rates = await db
      .select({
        codePrefix: gstRates.codePrefix,
        rate: gstRates.rate,
        validFrom: gstRates.validFrom,
        validTo: gstRates.validTo,
      })
      .from(gstRates)
      .where(inArray(gstRates.codePrefix, prefixes));
    return { ...empty, gstRates: rates };
  }

  if (request.websiteCountryCode === 'US') {
    const state = request.shipTo.regionCode;
    const [rates, certificates] = await Promise.all([
      db
        .select({
          stateCode: usRates.stateCode,
          zipPrefix: usRates.zipPrefix,
          rate: usRates.rate,
          shippingTaxable: usRates.shippingTaxable,
          validFrom: usRates.validFrom,
          validTo: usRates.validTo,
        })
        .from(usRates)
        .where(eq(usRates.stateCode, state)),
      db
        .select({
          stateCode: exemptions.stateCode,
          certificateNumber: exemptions.certificateNumber,
          expiresOn: exemptions.expiresOn,
        })
        .from(exemptions)
        .where(and(eq(exemptions.customerId, request.customerId), eq(exemptions.stateCode, state))),
    ]);
    return { ...empty, usRates: rates, exemptions: certificates };
  }

  return empty;
}

/** The tax engine of ADR 0017 for checkout: India GST and US sales tax from the tax tables. */
export function tableTaxProvider(db: Database): TaxProvider {
  return {
    name: TAX_PROVIDER_NAME,
    calculate: async (request) => calculateTax(request, await loadData(db, request)),
  };
}
