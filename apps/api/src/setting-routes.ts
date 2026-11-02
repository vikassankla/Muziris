import { findBuyerRole, type AdminPermission } from '@muziris/access';
import { findCustomer, findCustomerGroup } from '@muziris/customers';
import type { Database } from '@muziris/db';
import {
  clearSetting,
  findOrganization,
  findWebsite,
  loadStoredValues,
  resolveSetting,
  setSetting,
  SettingScopeNotAllowedError,
  type Scope,
  type ScopeContext,
} from '@muziris/platform';
import { Hono, type Context } from 'hono';
import { z, ZodError } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';
import { ADMIN_SETTINGS, findAdminSetting, type AdminSetting } from './settings.js';

// Settings under /admin/v1/settings (ADR 0021): each registered setting's effective value for
// a website, customer group or customer, and overrides at one scope. Values can hold personal
// data (an email address), so a change is logged by key and scope, never by value.

export interface SettingRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface SettingEnv {
  Variables: AdminAccessVariables;
}

const SCOPE_TYPES = ['customer', 'customer_group', 'website', 'organization', 'global'] as const;

const contextQuery = z.object({
  websiteId: z.uuid().optional(),
  customerGroupId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});

const scopeSchema = z.object({
  type: z.enum(SCOPE_TYPES),
  /** The website, customer group or customer; left out for organization and global. */
  id: z.uuid().optional(),
});

const putBody = z.object({ scope: scopeSchema, value: z.unknown() });

const notFound = (what: string) => new HttpProblem(404, `${what}_not_found`, `No such ${what}`);

function settingJson(setting: AdminSetting, value: unknown, source: string) {
  const { definition } = setting;
  return {
    key: definition.key,
    group: setting.group,
    label: setting.label,
    description: definition.description,
    editor: setting.editor,
    allowedScopes: definition.allowedScopes,
    defaultValue: definition.defaultValue,
    value,
    source,
  };
}

/** Settings under /admin/v1/settings. */
export function settingRoutes(deps: SettingRouteDependencies): Hono<SettingEnv> {
  const app = new Hono<SettingEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));
  const changed = (c: Context<SettingEnv>, event: string, fields: Record<string, unknown>) => {
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, ...fields },
      `setting.${event}`,
    );
  };

  /** The scope chain for a request: a customer brings its customer group. */
  async function contextFor(query: z.infer<typeof contextQuery>): Promise<ScopeContext> {
    const organization = await findOrganization(deps.db);
    const context: ScopeContext = organization ? { organizationId: organization.id } : {};
    if (query.websiteId !== undefined) {
      if (!(await findWebsite(deps.db, query.websiteId))) throw notFound('website');
      context.websiteId = query.websiteId;
    }
    let groupId = query.customerGroupId;
    if (query.customerId !== undefined) {
      const customer = await findCustomer(deps.db, query.customerId);
      if (!customer) throw notFound('customer');
      context.customerId = customer.id;
      groupId ??= customer.groupId ?? undefined;
    }
    if (groupId !== undefined) {
      if (!(await findCustomerGroup(deps.db, groupId))) throw notFound('customer_group');
      context.customerGroupId = groupId;
    }
    return context;
  }

  /** The scope a change applies to, checked to exist. */
  async function scopeFor(input: z.infer<typeof scopeSchema>): Promise<Scope> {
    if (input.type === 'global') return { type: 'global' };
    if (input.type === 'organization') {
      const organization = await findOrganization(deps.db);
      if (!organization) throw notFound('organization');
      return { type: 'organization', id: organization.id };
    }
    if (input.id === undefined) {
      throw new HttpProblem(
        400,
        'invalid_request',
        'The request is not valid',
        'Name the scope id',
      );
    }
    const exists =
      input.type === 'website'
        ? await findWebsite(deps.db, input.id)
        : input.type === 'customer_group'
          ? await findCustomerGroup(deps.db, input.id)
          : await findCustomer(deps.db, input.id);
    if (!exists) throw notFound(input.type);
    return { type: input.type, id: input.id };
  }

  function registered(key: string): AdminSetting {
    const setting = findAdminSetting(key);
    if (!setting) throw new HttpProblem(404, 'setting_not_found', 'No such setting');
    return setting;
  }

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/', need('setting.view'), async (c) => {
    const context = await contextFor(contextQuery.parse(c.req.query()));
    const stored = await loadStoredValues(
      deps.db,
      ADMIN_SETTINGS.map((s) => s.definition.key),
      context,
    );
    return c.json({
      settings: ADMIN_SETTINGS.map((setting) => {
        const resolved = resolveSetting(
          setting.definition,
          stored.filter((v) => v.key === setting.definition.key),
          context,
        );
        return settingJson(setting, resolved.value, resolved.source);
      }),
    });
  });

  app.put('/:key', need('setting.manage'), async (c) => {
    const setting = registered(c.req.param('key'));
    const input = putBody.parse(await body(c));
    const scope = await scopeFor(input.scope);
    let value: unknown;
    try {
      value = setting.definition.schema.parse(input.value);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      throw new HttpProblem(
        422,
        'setting_invalid_value',
        'The value is not valid for this setting',
        error.issues.map((issue) => issue.message).join('; '),
      );
    }
    if (setting.editor.kind === 'buyer_role' && typeof value === 'string') {
      if (!(await findBuyerRole(deps.db, value))) throw notFound('buyer_role');
    }
    try {
      await setSetting(deps.db, setting.definition, scope, value, {
        updatedByUserId: c.get('user').id,
      });
    } catch (error) {
      if (error instanceof SettingScopeNotAllowedError) {
        throw new HttpProblem(
          422,
          'setting_scope_not_allowed',
          'This setting cannot be set at that scope',
        );
      }
      throw error;
    }
    changed(c, 'set', { key: setting.definition.key, scope: scope.type });
    return c.json({ key: setting.definition.key, scope, value });
  });

  app.delete('/:key', need('setting.manage'), async (c) => {
    const setting = registered(c.req.param('key'));
    const query = z
      .object({ scope: z.enum(SCOPE_TYPES), scopeId: z.uuid().optional() })
      .parse(c.req.query());
    const scope = await scopeFor({
      type: query.scope,
      ...(query.scopeId === undefined ? {} : { id: query.scopeId }),
    });
    await clearSetting(deps.db, setting.definition, scope);
    changed(c, 'cleared', { key: setting.definition.key, scope: scope.type });
    return c.body(null, 204);
  });

  return app;
}
