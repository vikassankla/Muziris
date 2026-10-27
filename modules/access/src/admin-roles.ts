import type { Database } from '@muziris/db';
import { findUserById, type Realm } from '@muziris/identity';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { adminRolePermissions, adminRoles, adminUserRoles } from './db/schema.js';
import { AccessControlError, isUniqueViolation } from './errors.js';
import { ALL_ADMIN_PERMISSIONS, isAdminPermission, type AdminPermission } from './permissions.js';

/** The code of the built-in role that grants every admin permission. */
export const ADMINISTRATOR_ROLE_CODE = 'administrator';

/** What one admin user may do, resolved from all of their roles. */
export interface AdminAccess {
  /** True when one of the roles grants every permission. */
  readonly all: boolean;
  readonly permissions: ReadonlySet<AdminPermission>;
}

/**
 * The access of trusted system code, such as the admin:create command bootstrapping the first
 * administrator. Never derive it from a request.
 */
export const SYSTEM_ADMIN_ACCESS: AdminAccess = Object.freeze({
  all: true,
  permissions: new Set(ALL_ADMIN_PERMISSIONS),
});

export interface AdminRole {
  id: string;
  code: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  grantsAllPermissions: boolean;
  /** Sorted. For a role that grants all permissions, every permission in the catalogue. */
  permissions: AdminPermission[];
}

export function hasAdminPermission(access: AdminAccess, permission: AdminPermission): boolean {
  return access.all || access.permissions.has(permission);
}

const roleCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const adminPermissionSchema = z
  .string()
  .refine(isAdminPermission, { message: 'Unknown admin permission' });

export const newAdminRoleSchema = z.object({
  code: roleCodeSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).default(''),
  permissions: z.array(adminPermissionSchema).max(500),
});

export type NewAdminRole = z.input<typeof newAdminRoleSchema>;

const idSchema = z.uuid();

/** Refuses a change unless the actor holds every permission it involves. */
function assertHolds(
  actor: AdminAccess,
  permissions: Iterable<AdminPermission>,
  grantsAll = false,
): void {
  if (actor.all) return;
  if (grantsAll || [...permissions].some((p) => !actor.permissions.has(p))) {
    throw new AccessControlError(
      'privilege_escalation',
      'You can only grant or remove permissions you hold yourself',
    );
  }
}

/** Creates the built-in roles if they are missing. Safe to run repeatedly. */
export async function ensureBuiltInAdminRoles(db: Database): Promise<void> {
  await db
    .insert(adminRoles)
    .values({
      code: ADMINISTRATOR_ROLE_CODE,
      name: 'Administrator',
      description: 'Every admin permission, including ones added in later releases',
      isBuiltIn: true,
      grantsAllPermissions: true,
    })
    .onConflictDoNothing({ target: adminRoles.code });
}

async function loadRole(db: Database, roleId: string) {
  const [role] = await db
    .select()
    .from(adminRoles)
    .where(eq(adminRoles.id, idSchema.parse(roleId)))
    .limit(1);
  if (!role) throw new AccessControlError('role_not_found', 'No such admin role');
  const rows = await db
    .select({ permission: adminRolePermissions.permission })
    .from(adminRolePermissions)
    .where(eq(adminRolePermissions.roleId, role.id));
  return { role, permissions: rows.map((r) => r.permission).filter(isAdminPermission) };
}

export async function listAdminRoles(db: Database): Promise<AdminRole[]> {
  const roles = await db.select().from(adminRoles).orderBy(asc(adminRoles.code));
  const rows = await db.select().from(adminRolePermissions);
  return roles.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isBuiltIn: role.isBuiltIn,
    grantsAllPermissions: role.grantsAllPermissions,
    permissions: role.grantsAllPermissions
      ? [...ALL_ADMIN_PERMISSIONS].sort()
      : rows
          .filter((r) => r.roleId === role.id)
          .map((r) => r.permission)
          .filter(isAdminPermission)
          .sort(),
  }));
}

export async function findAdminRoleByCode(
  db: Database,
  code: string,
): Promise<AdminRole | undefined> {
  return (await listAdminRoles(db)).find((role) => role.code === code);
}

export async function createAdminRole(
  db: Database,
  actor: AdminAccess,
  input: NewAdminRole,
): Promise<AdminRole> {
  const values = newAdminRoleSchema.parse(input);
  const permissions = [...new Set(values.permissions)].sort();
  assertHolds(actor, permissions);
  try {
    return await db.transaction(async (tx) => {
      const [role] = await tx
        .insert(adminRoles)
        .values({ code: values.code, name: values.name, description: values.description })
        .returning();
      if (!role) throw new Error('Admin role insert returned no row');
      if (permissions.length > 0) {
        await tx
          .insert(adminRolePermissions)
          .values(permissions.map((permission) => ({ roleId: role.id, permission })));
      }
      return {
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        isBuiltIn: false,
        grantsAllPermissions: false,
        permissions,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AccessControlError('role_code_taken', 'An admin role with this code exists');
    }
    throw error;
  }
}

/**
 * Replaces a role's permissions. The actor must hold every permission being added or removed,
 * so nobody can widen a role beyond their own access or strip permissions they could not grant.
 */
export async function setAdminRolePermissions(
  db: Database,
  actor: AdminAccess,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  const next = new Set(z.array(adminPermissionSchema).max(500).parse(permissions));
  const { role, permissions: current } = await loadRole(db, roleId);
  if (role.isBuiltIn) {
    throw new AccessControlError('built_in_role', 'Built-in roles cannot be changed');
  }
  const changed = [
    ...[...next].filter((p) => !current.includes(p)),
    ...current.filter((p) => !next.has(p)),
  ];
  assertHolds(actor, changed);
  await db.transaction(async (tx) => {
    await tx.delete(adminRolePermissions).where(eq(adminRolePermissions.roleId, role.id));
    if (next.size > 0) {
      await tx
        .insert(adminRolePermissions)
        .values([...next].map((permission) => ({ roleId: role.id, permission })));
    }
    await tx
      .update(adminRoles)
      .set({ updatedAt: sql`now()` })
      .where(eq(adminRoles.id, role.id));
  });
}

/** Deletes a role and every assignment of it. */
export async function deleteAdminRole(
  db: Database,
  actor: AdminAccess,
  roleId: string,
): Promise<void> {
  const { role, permissions } = await loadRole(db, roleId);
  if (role.isBuiltIn) {
    throw new AccessControlError('built_in_role', 'Built-in roles cannot be deleted');
  }
  assertHolds(actor, permissions);
  await db.delete(adminRoles).where(eq(adminRoles.id, role.id));
}

/** Checks through identity that the user exists in the given realm. */
export async function assertUserInRealm(
  db: Database,
  userId: string,
  realm: Realm,
): Promise<string> {
  const id = idSchema.parse(userId);
  const user = await findUserById(db, id);
  if (user?.realm !== realm) {
    throw new AccessControlError('user_not_found', `No ${realm} user with this id`);
  }
  return id;
}

/** Gives an admin role to an admin user. Assigning a role the user already has does nothing. */
export async function assignAdminRole(
  db: Database,
  actor: AdminAccess,
  adminUserId: string,
  roleId: string,
): Promise<void> {
  const { role, permissions } = await loadRole(db, roleId);
  assertHolds(actor, permissions, role.grantsAllPermissions);
  const userId = await assertUserInRealm(db, adminUserId, 'admin');
  await db
    .insert(adminUserRoles)
    .values({ adminUserId: userId, roleId: role.id })
    .onConflictDoNothing();
}

/**
 * Takes an admin role away. Refuses to remove the last holder of a role that grants every
 * permission, so the install can never be left without an administrator.
 */
export async function unassignAdminRole(
  db: Database,
  actor: AdminAccess,
  adminUserId: string,
  roleId: string,
): Promise<void> {
  const { role, permissions } = await loadRole(db, roleId);
  assertHolds(actor, permissions, role.grantsAllPermissions);
  const userId = idSchema.parse(adminUserId);
  await db.transaction(async (tx) => {
    if (role.grantsAllPermissions) {
      // Lock the role row so two concurrent removals cannot both see another holder.
      await tx.execute(
        sql`select 1 from ${adminRoles} where ${adminRoles.id} = ${role.id} for update`,
      );
      const holders = await tx
        .select({ adminUserId: adminUserRoles.adminUserId })
        .from(adminUserRoles)
        .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
        .where(eq(adminRoles.grantsAllPermissions, true));
      const others = holders.filter((h) => h.adminUserId !== userId);
      if (others.length === 0 && holders.length > 0) {
        throw new AccessControlError(
          'last_administrator',
          'At least one admin user must keep the administrator role',
        );
      }
    }
    await tx
      .delete(adminUserRoles)
      .where(and(eq(adminUserRoles.adminUserId, userId), eq(adminUserRoles.roleId, role.id)));
  });
}

/** Everything an admin user may do, from all of their roles, in one query. */
export async function getAdminAccess(db: Database, adminUserId: string): Promise<AdminAccess> {
  const id = idSchema.safeParse(adminUserId);
  if (!id.success) return { all: false, permissions: new Set() };
  const rows = await db
    .select({
      grantsAll: adminRoles.grantsAllPermissions,
      permission: adminRolePermissions.permission,
    })
    .from(adminUserRoles)
    .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
    .leftJoin(adminRolePermissions, eq(adminRolePermissions.roleId, adminRoles.id))
    .where(eq(adminUserRoles.adminUserId, id.data));
  const all = rows.some((r) => r.grantsAll);
  const permissions = new Set<AdminPermission>(
    all
      ? ALL_ADMIN_PERMISSIONS
      : rows
          .map((r) => r.permission)
          .filter((p): p is AdminPermission => p !== null && isAdminPermission(p)),
  );
  return { all, permissions };
}
