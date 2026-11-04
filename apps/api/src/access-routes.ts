import {
  ACCESS_LEVELS,
  ADMIN_PERMISSIONS,
  AccessControlError,
  adminRolesOfUsers,
  assertAdminRolesAssignable,
  assertNotLastAdministrator,
  assignAdminRole,
  assignBuyerRole,
  BUYER_PERMISSIONS,
  createAdminRole,
  createBuyerRole,
  deleteAdminRole,
  deleteBuyerRole,
  getAdminAccess,
  hasAdminPermission,
  listAdminRoles,
  listBuyerRoles,
  listBuyerRolesQuerySchema,
  newBuyerRoleSchema,
  setAdminRolePermissions,
  setBuyerRoleGrants,
  unassignAdminRole,
  unassignBuyerRole,
  type BuyerRoleGrant,
  type AccessControlErrorCode,
  type AdminAccess,
  type AdminPermission,
} from '@muziris/access';
import type { Database } from '@muziris/db';
import {
  disableUser,
  EmailTakenError,
  enableUser,
  findUserById,
  findUserSummary,
  IdentityError,
  inviteAdminUser,
  listUsers,
  listUsersQuerySchema,
  resendAdminInvitation,
  resetTwoFactor,
  type UserSummary,
} from '@muziris/identity';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requireSession, trustedOriginGuard, type AuthVariables } from './auth-routes.js';
import type { Emails } from './emails.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

export interface AccessRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
  /** Admin invitation emails (ADR 0028). */
  emails: Emails;
}

export interface AdminAccessVariables extends AuthVariables {
  access: AdminAccess;
}

interface AdminAccessEnv {
  Variables: AdminAccessVariables;
}

/**
 * Requires the signed-in admin to hold a permission. Mount after requireSession('admin').
 * Permissions are read on every request, so a change applies at once.
 */
export function requirePermission(
  permission: AdminPermission,
  deps: Pick<AccessRouteDependencies, 'db' | 'logger'>,
): MiddlewareHandler<AdminAccessEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (user.realm !== 'admin') {
      throw new HttpProblem(403, 'permission_denied', 'You do not have permission to do this');
    }
    const access = await getAdminAccess(deps.db, user.id);
    if (!hasAdminPermission(access, permission)) {
      deps.logger.info(
        { requestId: c.get('requestId'), userId: user.id, permission },
        'access.permission_denied',
      );
      throw new HttpProblem(403, 'permission_denied', 'You do not have permission to do this');
    }
    c.set('access', access);
    await next();
  };
}

const PROBLEMS: Record<AccessControlErrorCode, [ContentfulStatusCode, string]> = {
  role_not_found: [404, 'No such role'],
  user_not_found: [404, 'No such user'],
  role_code_taken: [409, 'A role with this code already exists'],
  built_in_role: [409, 'Built-in roles cannot be changed or deleted'],
  privilege_escalation: [403, 'You can only grant or remove permissions you hold yourself'],
  last_administrator: [409, 'At least one admin user must keep the administrator role'],
};

/** Runs a module call, turning refusals into problem responses with the same stable code. */
async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AccessControlError) {
      const [status, title] = PROBLEMS[error.code];
      throw new HttpProblem(status, error.code, title);
    }
    throw error;
  }
}

const idParam = z.uuid();

const createRoleBody = z.object({
  code: z.string().max(63),
  name: z.string().max(200),
  description: z.string().max(1000).optional(),
  permissions: z.array(z.string().max(100)).max(500),
});

const setPermissionsBody = z.object({
  permissions: z.array(z.string().max(100)).max(500),
});

/** Query strings carry text only; turn them into the module's query shape. */
const listBuyerRolesQuery = z
  .object({
    after: z.string().max(100).optional(),
    limit: z
      .string()
      .regex(/^\d{1,4}$/, 'Use a whole number')
      .optional(),
  })
  .transform(({ after, limit }) =>
    listBuyerRolesQuerySchema.parse({
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    }),
  );

const listAdminUsersQuery = z
  .object({
    after: z.string().max(100).optional(),
    limit: z
      .string()
      .regex(/^\d{1,4}$/, 'Use a whole number')
      .optional(),
  })
  .transform(({ after, limit }) =>
    listUsersQuerySchema.parse({
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    }),
  );

const inviteAdminBody = z.object({
  displayName: z.string().max(200),
  email: z.string().max(254),
  roleIds: z.array(z.uuid()).max(50).default([]),
});

const IDENTITY_PROBLEMS: Partial<Record<string, [ContentfulStatusCode, string]>> = {
  user_not_found: [404, 'No such admin user'],
  not_invited: [409, 'This admin user has already accepted the invitation'],
};

/** Runs an identity call, turning its refusals into problem responses. */
async function identityTranslated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof IdentityError) {
      const known = IDENTITY_PROBLEMS[error.code];
      if (known) throw new HttpProblem(known[0], error.code, known[1]);
    }
    if (error instanceof EmailTakenError) {
      throw new HttpProblem(409, 'email_taken', 'An admin user with this email already exists');
    }
    throw error;
  }
}

/** How the admin users screen shows an account: invited until a password is set. */
function adminUserView(user: UserSummary, roles: { id: string; name: string }[]) {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    status: user.status === 'disabled' ? 'disabled' : user.invited ? 'invited' : 'active',
    twoFactor: user.twoFactor,
    lastSignInAt: user.lastLoginAt?.toISOString() ?? null,
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
  };
}

const setGrantsBody = z.object({
  grants: newBuyerRoleSchema.shape.grants,
});

/**
 * Admin roles, permissions and assignments, and buyer roles and their assignments to buyer
 * users, mounted under /admin/v1/access.
 */
export function accessRoutes(deps: AccessRouteDependencies): Hono<AdminAccessEnv> {
  const app = new Hono<AdminAccessEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  /** What the signed-in admin may do, so the admin app can hide what they cannot. */
  app.get('/me', async (c) => {
    const access = await getAdminAccess(deps.db, c.get('user').id);
    return c.json({ permissions: [...access.permissions].sort() });
  });

  app.get('/permissions', need('admin_role.view'), (c) =>
    c.json({
      permissions: Object.entries(ADMIN_PERMISSIONS).map(([key, description]) => ({
        key,
        description,
      })),
    }),
  );

  app.get('/roles', need('admin_role.view'), async (c) =>
    c.json({ roles: await listAdminRoles(deps.db) }),
  );

  app.post('/roles', need('admin_role.manage'), async (c) => {
    const body = createRoleBody.parse(await c.req.json().catch(() => ({})));
    const role = await translated(() => createAdminRole(deps.db, c.get('access'), body));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, roleId: role.id },
      'access.admin_role_created',
    );
    return c.json({ role }, 201);
  });

  app.put('/roles/:roleId/permissions', need('admin_role.manage'), async (c) => {
    const roleId = idParam.parse(c.req.param('roleId'));
    const body = setPermissionsBody.parse(await c.req.json().catch(() => ({})));
    await translated(() =>
      setAdminRolePermissions(deps.db, c.get('access'), roleId, body.permissions),
    );
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, roleId },
      'access.admin_role_permissions_set',
    );
    return c.body(null, 204);
  });

  app.delete('/roles/:roleId', need('admin_role.manage'), async (c) => {
    const roleId = idParam.parse(c.req.param('roleId'));
    await translated(() => deleteAdminRole(deps.db, c.get('access'), roleId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, roleId },
      'access.admin_role_deleted',
    );
    return c.body(null, 204);
  });

  /** One admin user as the screen shows them, or 404. */
  async function viewOf(userId: string) {
    const user = await findUserSummary(deps.db, 'admin', userId);
    if (!user) throw new HttpProblem(404, 'user_not_found', 'No such admin user');
    const roles = await adminRolesOfUsers(deps.db, [user.id]);
    return adminUserView(user, roles.get(user.id) ?? []);
  }

  /** Admin users by name, with their roles, two-factor sign-in and last sign-in (ADR 0028). */
  app.get('/admin-users', need('admin_user.view'), async (c) => {
    const query = listAdminUsersQuery.parse(c.req.query());
    const page = await listUsers(deps.db, 'admin', query);
    const roles = await adminRolesOfUsers(
      deps.db,
      page.users.map((u) => u.id),
    );
    return c.json({
      adminUsers: page.users.map((u) => adminUserView(u, roles.get(u.id) ?? [])),
      nextAfter: page.nextAfter,
    });
  });

  /**
   * Invites an admin: an account with no password, the roles given, and an email with a link to
   * set the password. Giving roles needs admin_role.assign and every permission they grant.
   */
  app.post('/admin-users', need('admin_user.manage'), async (c) => {
    const body = inviteAdminBody.parse(await c.req.json().catch(() => ({})));
    const access = c.get('access');
    if (body.roleIds.length > 0 && !hasAdminPermission(access, 'admin_role.assign')) {
      throw new HttpProblem(403, 'permission_denied', 'You do not have permission to give roles');
    }
    await translated(() => assertAdminRolesAssignable(deps.db, access, body.roleIds));
    const hooks = await deps.emails.adminInvitation(c.get('user'));
    const created = await identityTranslated(() =>
      inviteAdminUser(
        deps.db,
        {
          email: body.email,
          displayName: body.displayName,
          invitedByUserId: c.get('user').id,
          now: deps.now(),
        },
        hooks,
      ),
    );
    for (const roleId of new Set(body.roleIds)) {
      try {
        await assignAdminRole(deps.db, access, created.user.id, roleId);
      } catch (error) {
        // Checked above; a role deleted in between is left out, and logged.
        if (!(error instanceof AccessControlError)) throw error;
        deps.logger.warn(
          { requestId: c.get('requestId'), targetUserId: created.user.id, roleId },
          'access.admin_invitation_role_missing',
        );
      }
    }
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        userId: c.get('user').id,
        targetUserId: created.user.id,
        invitationId: created.invitation.id,
      },
      'access.admin_user_invited',
    );
    return c.json({ adminUser: await viewOf(created.user.id) }, 201);
  });

  /** Sends the invitation again with a new link, while the admin has not accepted. */
  app.post('/admin-users/:userId/invitation', need('admin_user.manage'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    const hooks = await deps.emails.adminInvitation(c.get('user'));
    const created = await identityTranslated(() =>
      resendAdminInvitation(
        deps.db,
        { userId, invitedByUserId: c.get('user').id, now: deps.now() },
        hooks,
      ),
    );
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        userId: c.get('user').id,
        targetUserId: userId,
        invitationId: created.invitation.id,
      },
      'access.admin_invitation_resent',
    );
    return c.json({ adminUser: await viewOf(userId) });
  });

  /**
   * Disables an admin and ends their sessions. Never yourself, and never the last active
   * administrator.
   */
  app.post('/admin-users/:userId/disable', need('admin_user.manage'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    if (userId === c.get('user').id) {
      throw new HttpProblem(409, 'own_account', 'You cannot disable your own account');
    }
    await viewOf(userId);
    await translated(() => assertNotLastAdministrator(deps.db, userId));
    await disableUser(deps.db, userId);
    deps.logger.warn(
      { requestId: c.get('requestId'), userId: c.get('user').id, targetUserId: userId },
      'access.admin_user_disabled',
    );
    return c.json({ adminUser: await viewOf(userId) });
  });

  /** Lets a disabled admin sign in again. */
  app.post('/admin-users/:userId/enable', need('admin_user.manage'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    await viewOf(userId);
    await enableUser(deps.db, userId);
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, targetUserId: userId },
      'access.admin_user_enabled',
    );
    return c.json({ adminUser: await viewOf(userId) });
  });

  app.put('/admin-users/:userId/roles/:roleId', need('admin_role.assign'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    const roleId = idParam.parse(c.req.param('roleId'));
    await translated(() => assignAdminRole(deps.db, c.get('access'), userId, roleId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, targetUserId: userId, roleId },
      'access.admin_role_assigned',
    );
    return c.body(null, 204);
  });

  app.delete('/admin-users/:userId/roles/:roleId', need('admin_role.assign'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    const roleId = idParam.parse(c.req.param('roleId'));
    await translated(() => unassignAdminRole(deps.db, c.get('access'), userId, roleId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, targetUserId: userId, roleId },
      'access.admin_role_unassigned',
    );
    return c.body(null, 204);
  });

  /**
   * Resets another admin's second factor (ADR 0026): their sessions end, and they enrol again at
   * their next sign-in. An admin moves their own to a new phone on their Security page instead.
   */
  app.post('/admin-users/:userId/two-factor/reset', need('admin_user.manage'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    if (userId === c.get('user').id) {
      throw new HttpProblem(
        409,
        'own_two_factor',
        'You cannot reset your own two-factor sign-in',
        'Use Security on your profile to move it to a new phone.',
      );
    }
    const target = await findUserById(deps.db, userId);
    if (target?.realm !== 'admin') throw new HttpProblem(404, 'user_not_found', 'No such user');
    const hadFactor = await resetTwoFactor(deps.db, userId, deps.now());
    deps.logger.warn(
      { requestId: c.get('requestId'), userId: c.get('user').id, targetUserId: userId, hadFactor },
      'auth.two_factor_reset',
    );
    return c.body(null, 204);
  });

  /** The buyer permission catalogue and access levels, for the buyer role editor. */
  app.get('/buyer-permissions', need('buyer_role.view'), (c) =>
    c.json({
      permissions: Object.entries(BUYER_PERMISSIONS).map(([key, description]) => ({
        key,
        description,
      })),
      accessLevels: ACCESS_LEVELS,
    }),
  );

  app.get('/buyer-roles', need('buyer_role.view'), async (c) =>
    c.json(await listBuyerRoles(deps.db, listBuyerRolesQuery.parse(c.req.query()))),
  );

  app.post('/buyer-roles', need('buyer_role.manage'), async (c) => {
    const body = newBuyerRoleSchema.parse(await c.req.json().catch(() => ({})));
    const buyerRole = await translated(() => createBuyerRole(deps.db, body));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, buyerRoleId: buyerRole.id },
      'access.buyer_role_created',
    );
    return c.json({ buyerRole }, 201);
  });

  app.put('/buyer-roles/:roleId/grants', need('buyer_role.manage'), async (c) => {
    const roleId = idParam.parse(c.req.param('roleId'));
    const { grants } = setGrantsBody.parse(await c.req.json().catch(() => ({})));
    await translated(() => setBuyerRoleGrants(deps.db, roleId, grants as BuyerRoleGrant[]));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, buyerRoleId: roleId },
      'access.buyer_role_grants_set',
    );
    return c.body(null, 204);
  });

  app.delete('/buyer-roles/:roleId', need('buyer_role.manage'), async (c) => {
    const roleId = idParam.parse(c.req.param('roleId'));
    await translated(() => deleteBuyerRole(deps.db, roleId));
    deps.logger.info(
      { requestId: c.get('requestId'), userId: c.get('user').id, buyerRoleId: roleId },
      'access.buyer_role_deleted',
    );
    return c.body(null, 204);
  });

  app.put('/buyer-users/:userId/buyer-roles/:roleId', need('buyer_role.manage'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    const roleId = idParam.parse(c.req.param('roleId'));
    await translated(() => assignBuyerRole(deps.db, userId, roleId));
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        userId: c.get('user').id,
        buyerUserId: userId,
        buyerRoleId: roleId,
      },
      'access.buyer_role_assigned',
    );
    return c.body(null, 204);
  });

  app.delete('/buyer-users/:userId/buyer-roles/:roleId', need('buyer_role.manage'), async (c) => {
    const userId = idParam.parse(c.req.param('userId'));
    const roleId = idParam.parse(c.req.param('roleId'));
    await translated(() => unassignBuyerRole(deps.db, userId, roleId));
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        userId: c.get('user').id,
        buyerUserId: userId,
        buyerRoleId: roleId,
      },
      'access.buyer_role_unassigned',
    );
    return c.body(null, 204);
  });

  return app;
}
