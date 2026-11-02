import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  createWebsite,
  findOrganization,
  findWebsite,
  findWebsiteByCode,
  listWebsites,
  newWebsiteSchema,
  updateWebsite,
  websiteChangesSchema,
} from '@muziris/platform';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

// Websites under /admin/v1/websites (ADR 0021). A website's code, country and currency are
// fixed once it exists; the rest can change. Every change is logged with the admin who made it.

export interface WebsiteRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface WebsiteEnv {
  Variables: AdminAccessVariables;
}

/**
 * The pilot sells in India and the US, in English, in rupees and dollars (ADR 0021): the admin
 * and storefront format only these, and payments take only these currencies.
 */
export const PILOT_COUNTRIES = ['IN', 'US'] as const;
export const PILOT_LOCALES = ['en-IN', 'en-US'] as const;
export const PILOT_CURRENCIES = ['INR', 'USD'] as const;

const createBody = newWebsiteSchema.omit({ organizationId: true }).extend({
  countryCode: z.enum(PILOT_COUNTRIES),
  defaultLocale: z.enum(PILOT_LOCALES),
  defaultCurrency: z.enum(PILOT_CURRENCIES),
});
const changesBody = websiteChangesSchema.extend({ defaultLocale: z.enum(PILOT_LOCALES) }).partial();

const idParam = z.uuid();

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

const notFound = () => new HttpProblem(404, 'website_not_found', 'No such website');

/** Websites under /admin/v1/websites. */
export function websiteRoutes(deps: WebsiteRouteDependencies): Hono<WebsiteEnv> {
  const app = new Hono<WebsiteEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));
  const changed = (c: Context<WebsiteEnv>, event: string, fields: Record<string, unknown>) => {
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ...fields },
      `website.${event}`,
    );
  };

  async function organization() {
    const found = await findOrganization(deps.db);
    if (!found) {
      throw new HttpProblem(
        409,
        'organization_missing',
        'This install has no organization yet',
        'Run pnpm --filter @muziris/api setup --organization "<name>" first',
      );
    }
    return found;
  }

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  // Every admin screen formats money and dates by the website chosen in the top bar, so any
  // signed-in admin may list websites; reading one and changing them need the permissions.
  app.get('/', async (c) => {
    const found = await findOrganization(deps.db);
    return c.json({ websites: found ? await listWebsites(deps.db, found.id) : [] });
  });

  app.post('/', need('website.manage'), async (c) => {
    const input = createBody.parse(await body(c));
    const { id: organizationId } = await organization();
    if (await findWebsiteByCode(deps.db, input.code)) {
      throw new HttpProblem(409, 'website_code_taken', 'That website code is taken');
    }
    try {
      const website = await createWebsite(deps.db, { ...input, organizationId });
      changed(c, 'created', { websiteId: website.id, code: website.code });
      return c.json({ website }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpProblem(409, 'website_code_taken', 'That website code is taken');
      }
      throw error;
    }
  });

  app.get('/:websiteId', need('website.view'), async (c) => {
    const website = await findWebsite(deps.db, idParam.parse(c.req.param('websiteId')));
    if (!website) throw notFound();
    return c.json({ website });
  });

  app.patch('/:websiteId', need('website.manage'), async (c) => {
    const websiteId = idParam.parse(c.req.param('websiteId'));
    const changes = changesBody.parse(await body(c));
    const website = await updateWebsite(deps.db, websiteId, changes, deps.now());
    if (!website) throw notFound();
    changed(c, 'changed', { websiteId, fields: Object.keys(changes) });
    return c.json({ website });
  });

  return app;
}
