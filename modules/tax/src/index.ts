// Public interface of the tax module (ADR 0017). Other modules import only from here.
export {
  appliesOn,
  calculateGst,
  calculateTax,
  calculateUs,
  gstRateFor,
  localDay,
  rateText,
  TAX_PROVIDER_NAME,
  usRateFor,
  UTGST_STATE_CODES,
  type ExemptionRow,
  type GstRateRow,
  type RegistrationRow,
  type TaxData,
  type UsRateRow,
} from './calculate.js';
export { TaxError, type TaxErrorCode } from './errors.js';
export {
  addExemption,
  deleteExemption,
  listExemptions,
  newExemptionSchema,
  type Exemption,
} from './exemptions.js';
export { tableTaxProvider } from './provider.js';
export {
  addGstRate,
  addUsRate,
  deleteGstRate,
  deleteUsRate,
  endGstRate,
  endUsRate,
  importUsRates,
  listGstRates,
  listRatesQuerySchema,
  listUsRates,
  MAX_IMPORT_ROWS,
  newGstRateSchema,
  newUsRateSchema,
  parseUsRatesCsv,
  rateEndSchema,
  US_RATES_CSV_HEADER,
  type GstRate,
  type UsRate,
} from './rates.js';
export {
  addUsRegistration,
  deleteRegistration,
  gstRegistrationSchema,
  listRegistrations,
  setGstRegistration,
  usRegistrationSchema,
  type Registration,
} from './registrations.js';
