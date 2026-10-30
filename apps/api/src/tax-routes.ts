import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  addExemption,
  addGstRate,
  addUsRate,
  addUsRegistration,
  deleteExemption,
  deleteGstRate,
  deleteRegistration,
  deleteUsRate,
  endGstRate,
  endUsRate,
  importUsRates,
  listExemptions,
  listGstRates,
  listRegistrations,
  listUsRates,
  setGstRegistration,
  TaxError,
  type TaxErrorCode,
} from '@muziris/tax';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem, problemResponse, toProblem } from './problem.js';

// Tax registrations, rates and exemption certificates under /admin/v1/tax (ADR 0017). Changing
// them changes what buyers pay, so every change is logged with the admin who made it.

export interface TaxRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface TaxEnv {
  Variables: AdminAccessVariables;
}

const PROBLEMS: Record<TaxErrorCode, [ContentfulStatusCode, string]> = {
  website_not_found: [404, 'No such website'],
  customer_not_found: [404, 'No such customer'],
  registration_not_found: [404, 'No such registration'],
  registration_taken: [409, 'The website already has a registration for this state'],
  wrong_regime: [422, "The registration does not fit the website's country"],
  rate_not_found: [404, 'No such rate'],
  rate_overlaps: [409, 'Another rate applies on some of the same days'],
  exemption_not_found: [404, 'No such exemption certificate'],
  exemption_taken: [409, 'The customer already has a certificate for this state'],
  invalid_import: [422, 'The file has rows that are not valid; nothing was imported'],
};

/** Runs a module call, turning refusals into problem responses with the same stable code. */
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TaxError) {
      const [status, title] = PROBLEMS[error.code];
      throw new HttpProblem(status, error.code, title, error.message);
    }
    throw error;
  }
}

const idParam = z.uuid();
const queryText = z.string().max(100).optional();

/** Drops keys whose value is undefined, for exactOptionalPropertyTypes. */
function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

const ratesQuery = z.object({ on: queryText, codePrefix: queryText, stateCode: queryText });

/** Tax under /admin/v1/tax. */
export function taxRoutes(deps: TaxRouteDependencies): Hono<TaxEnv> {
  const app = new Hono<TaxEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));
  const changed = (c: Context<TaxEnv>, event: string, fields: Record<string, unknown>) => {
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ...fields },
      `tax.${event}`,
    );
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  // Registrations

  app.get('/websites/:websiteId/registrations', need('tax.view'), async (c) =>
    c.json({
      registrations: await listRegistrations(deps.db, idParam.parse(c.req.param('websiteId'))),
    }),
  );

  app.put('/websites/:websiteId/gst-registration', need('tax.manage'), async (c) => {
    const websiteId = idParam.parse(c.req.param('websiteId'));
    const input = (await body(c)) as { gstin?: string };
    const registration = await translated(() =>
      setGstRegistration(deps.db, websiteId, { gstin: input.gstin ?? '' }),
    );
    changed(c, 'gst_registration_set', { websiteId, gstin: registration.number });
    return c.json({ registration });
  });

  app.post('/websites/:websiteId/us-registrations', need('tax.manage'), async (c) => {
    const websiteId = idParam.parse(c.req.param('websiteId'));
    const input = z
      .object({ stateCode: z.string(), permitNumber: z.string() })
      .parse(await body(c));
    const registration = await translated(() => addUsRegistration(deps.db, websiteId, input));
    changed(c, 'us_registration_added', { websiteId, stateCode: registration.regionCode });
    return c.json({ registration }, 201);
  });

  app.delete('/registrations/:registrationId', need('tax.manage'), async (c) => {
    const registrationId = idParam.parse(c.req.param('registrationId'));
    await translated(() => deleteRegistration(deps.db, registrationId));
    changed(c, 'registration_deleted', { registrationId });
    return c.body(null, 204);
  });

  // GST rates

  app.get('/gst-rates', need('tax.view'), async (c) => {
    const q = ratesQuery.parse(c.req.query());
    return c.json({
      rates: await listGstRates(deps.db, defined({ on: q.on, codePrefix: q.codePrefix })),
    });
  });

  app.post('/gst-rates', need('tax.manage'), async (c) => {
    const input = (await body(c)) as Parameters<typeof addGstRate>[2];
    const rate = await translated(() => addGstRate(deps.db, c.get('user').id, input));
    changed(c, 'gst_rate_added', { rateId: rate.id, codePrefix: rate.codePrefix, rate: rate.rate });
    return c.json({ rate }, 201);
  });

  app.patch('/gst-rates/:rateId', need('tax.manage'), async (c) => {
    const rateId = idParam.parse(c.req.param('rateId'));
    const input = (await body(c)) as Parameters<typeof endGstRate>[3];
    const rate = await translated(() => endGstRate(deps.db, c.get('user').id, rateId, input));
    changed(c, 'gst_rate_ended', { rateId, validTo: rate.validTo });
    return c.json({ rate });
  });

  app.delete('/gst-rates/:rateId', need('tax.manage'), async (c) => {
    const rateId = idParam.parse(c.req.param('rateId'));
    await translated(() => deleteGstRate(deps.db, rateId));
    changed(c, 'gst_rate_deleted', { rateId });
    return c.body(null, 204);
  });

  // US rates

  app.get('/us-rates', need('tax.view'), async (c) => {
    const q = ratesQuery.parse(c.req.query());
    return c.json({
      rates: await listUsRates(
        deps.db,
        defined({ on: q.on, stateCode: q.stateCode?.toUpperCase() }),
      ),
    });
  });

  app.post('/us-rates', need('tax.manage'), async (c) => {
    const input = (await body(c)) as Parameters<typeof addUsRate>[2];
    const rate = await translated(() => addUsRate(deps.db, c.get('user').id, input));
    changed(c, 'us_rate_added', {
      rateId: rate.id,
      stateCode: rate.stateCode,
      zipPrefix: rate.zipPrefix,
      rate: rate.rate,
    });
    return c.json({ rate }, 201);
  });

  /** A CSV of rates (text/csv): all of them are imported, or none. */
  app.post('/us-rates/import', need('tax.manage'), async (c) => {
    if (!(c.req.header('content-type') ?? '').startsWith('text/csv')) {
      throw new HttpProblem(415, 'unsupported_media_type', 'Send the rates as text/csv');
    }
    const csv = await c.req.text();
    try {
      const result = await importUsRates(deps.db, c.get('user').id, csv);
      changed(c, 'us_rates_imported', { imported: result.imported });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof TaxError && error.code === 'invalid_import') {
        const [status, title] = PROBLEMS.invalid_import;
        return problemResponse(c, {
          ...toProblem(c, new HttpProblem(status, error.code, title, error.message)),
          errors: error.rows.map((r) => ({ path: `row ${r.row}`, message: r.message })),
        });
      }
      throw error;
    }
  });

  app.patch('/us-rates/:rateId', need('tax.manage'), async (c) => {
    const rateId = idParam.parse(c.req.param('rateId'));
    const input = (await body(c)) as Parameters<typeof endUsRate>[3];
    const rate = await translated(() => endUsRate(deps.db, c.get('user').id, rateId, input));
    changed(c, 'us_rate_ended', { rateId, validTo: rate.validTo });
    return c.json({ rate });
  });

  app.delete('/us-rates/:rateId', need('tax.manage'), async (c) => {
    const rateId = idParam.parse(c.req.param('rateId'));
    await translated(() => deleteUsRate(deps.db, rateId));
    changed(c, 'us_rate_deleted', { rateId });
    return c.body(null, 204);
  });

  // US exemption certificates

  app.get('/exemptions', need('tax.view'), async (c) => {
    const { customerId } = z.object({ customerId: z.uuid().optional() }).parse(c.req.query());
    return c.json({
      exemptions: await listExemptions(deps.db, customerId === undefined ? {} : { customerId }),
    });
  });

  app.post('/exemptions', need('tax.manage'), async (c) => {
    const input = (await body(c)) as Parameters<typeof addExemption>[2];
    const exemption = await translated(() => addExemption(deps.db, c.get('user').id, input));
    changed(c, 'exemption_added', {
      exemptionId: exemption.id,
      customerId: exemption.customerId,
      stateCode: exemption.stateCode,
    });
    return c.json({ exemption }, 201);
  });

  app.delete('/exemptions/:exemptionId', need('tax.manage'), async (c) => {
    const exemptionId = idParam.parse(c.req.param('exemptionId'));
    await translated(() => deleteExemption(deps.db, exemptionId));
    changed(c, 'exemption_deleted', { exemptionId });
    return c.body(null, 204);
  });

  return app;
}
