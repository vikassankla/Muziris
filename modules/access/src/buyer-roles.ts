import type { Database } from '@muziris/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertUserInRealm } from './admin-roles.js';
import { buyerRolePermissions, buyerRoles, buyerUserRoles } from './db/schema.js';
import { AccessControlError, isUniqueViolation } from './errors.js';
import {
  ACCESS_LEVELS,
  isBuyerPermission,
  widerAccessLevel,
  type AccessLevel,
  type BuyerPermission,
} from './permissions.js';

/** What one buyer user may do: the widest access level per permission across their roles. */
export type BuyerAccess = ReadonlyMap<BuyerPermission, AccessLevel>;

export interface BuyerRoleGrant {
  permission: BuyerPermission;
  accessLevel: AccessLevel;
}

export interface BuyerRole {
  id: string;
  code: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  /** Sorted by permission. */
  grants: BuyerRoleGrant[];
}

const grantSchema = z.object({
  permission: z.string().refine(isBuyerPermission, { message: 'Unknown buyer permission' }),
  accessLevel: z.enum(ACCESS_LEVELS),
});

const grantsSchema = z
  .array(grantSchema)
  .max(500)
  .refine((grants) => new Set(grants.map((g) => g.permission)).size === grants.length, {
    message: 'Each permission may appear once',
  });

export const newBuyerRoleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).default(''),
  grants: grantsSchema,
});

export type NewBuyerRole = z.input<typeof newBuyerRoleSchema>;

const idSchema = z.uuid();

const byPermission = (a: BuyerRoleGrant, b: BuyerRoleGrant) =>
  a.permission.localeCompare(b.permission);

async function loadRole(db: Database, roleId: string) {
  const [role] = await db
    .select()
    .from(buyerRoles)
    .where(eq(buyerRoles.id, idSchema.parse(roleId)))
    .limit(1);
  if (!role) throw new AccessControlError('role_not_found', 'No such buyer role');
  return role;
}

export const listBuyerRolesQuerySchema = z.object({
  /** Continue after this role id, from the previous page's nextAfter. */
  after: z.uuid().optional(),
  limit: z.int().min(1).max(200).default(50),
});

export type ListBuyerRolesQuery = z.input<typeof listBuyerRolesQuerySchema>;

export interface BuyerRolePage {
  buyerRoles: BuyerRole[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextAfter: string | null;
}

/** Buyer roles by code, with their grants, a page at a time. An unknown `after` gives none. */
export async function listBuyerRoles(
  db: Database,
  query: ListBuyerRolesQuery = {},
): Promise<BuyerRolePage> {
  const q = listBuyerRolesQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(buyerRoles)
    .where(
      q.after === undefined
        ? undefined
        : sql`${buyerRoles.code} > (select code from ${buyerRoles} where id = ${q.after})`,
    )
    .orderBy(asc(buyerRoles.code))
    .limit(q.limit + 1);
  const roles = rows.slice(0, q.limit);
  const grants =
    roles.length === 0
      ? []
      : await db
          .select()
          .from(buyerRolePermissions)
          .where(
            inArray(
              buyerRolePermissions.roleId,
              roles.map((r) => r.id),
            ),
          );
  const last = roles.at(-1);
  return {
    buyerRoles: roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isBuiltIn: role.isBuiltIn,
      grants: grants
        .filter((r) => r.roleId === role.id && isBuyerPermission(r.permission))
        .map((r) => ({ permission: r.permission as BuyerPermission, accessLevel: r.accessLevel }))
        .sort(byPermission),
    })),
    nextAfter: rows.length > q.limit && last ? last.id : null,
  };
}

export async function createBuyerRole(db: Database, input: NewBuyerRole): Promise<BuyerRole> {
  const values = newBuyerRoleSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [role] = await tx
        .insert(buyerRoles)
        .values({ code: values.code, name: values.name, description: values.description })
        .returning();
      if (!role) throw new Error('Buyer role insert returned no row');
      if (values.grants.length > 0) {
        await tx
          .insert(buyerRolePermissions)
          .values(values.grants.map((g) => ({ roleId: role.id, ...g })));
      }
      return {
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        isBuiltIn: false,
        grants: [...values.grants].sort(byPermission),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AccessControlError('role_code_taken', 'A buyer role with this code exists');
    }
    throw error;
  }
}

/** Replaces a buyer role's permissions and access levels. */
export async function setBuyerRoleGrants(
  db: Database,
  roleId: string,
  grants: readonly BuyerRoleGrant[],
): Promise<void> {
  const next = grantsSchema.parse(grants);
  const role = await loadRole(db, roleId);
  if (role.isBuiltIn) {
    throw new AccessControlError('built_in_role', 'Built-in roles cannot be changed');
  }
  await db.transaction(async (tx) => {
    await tx.delete(buyerRolePermissions).where(eq(buyerRolePermissions.roleId, role.id));
    if (next.length > 0) {
      await tx.insert(buyerRolePermissions).values(next.map((g) => ({ roleId: role.id, ...g })));
    }
    await tx
      .update(buyerRoles)
      .set({ updatedAt: sql`now()` })
      .where(eq(buyerRoles.id, role.id));
  });
}

export async function deleteBuyerRole(db: Database, roleId: string): Promise<void> {
  const role = await loadRole(db, roleId);
  if (role.isBuiltIn) {
    throw new AccessControlError('built_in_role', 'Built-in roles cannot be deleted');
  }
  await db.delete(buyerRoles).where(eq(buyerRoles.id, role.id));
}

/** Gives a buyer role to a buyer user. Assigning a role the user already has does nothing. */
export async function assignBuyerRole(
  db: Database,
  buyerUserId: string,
  roleId: string,
): Promise<void> {
  const role = await loadRole(db, roleId);
  const userId = await assertUserInRealm(db, buyerUserId, 'buyer');
  await db
    .insert(buyerUserRoles)
    .values({ buyerUserId: userId, roleId: role.id })
    .onConflictDoNothing();
}

export async function unassignBuyerRole(
  db: Database,
  buyerUserId: string,
  roleId: string,
): Promise<void> {
  await db
    .delete(buyerUserRoles)
    .where(
      and(
        eq(buyerUserRoles.buyerUserId, idSchema.parse(buyerUserId)),
        eq(buyerUserRoles.roleId, idSchema.parse(roleId)),
      ),
    );
}

/** Merges role grants into one access level per permission, keeping the widest. */
export function mergeBuyerGrants(grants: Iterable<BuyerRoleGrant>): BuyerAccess {
  const access = new Map<BuyerPermission, AccessLevel>();
  for (const grant of grants) {
    const level = widerAccessLevel(access.get(grant.permission), grant.accessLevel);
    if (level) access.set(grant.permission, level);
  }
  return access;
}

/** Everything a buyer user may do, from all of their roles, in one query. */
export async function getBuyerAccess(db: Database, buyerUserId: string): Promise<BuyerAccess> {
  const id = idSchema.safeParse(buyerUserId);
  if (!id.success) return new Map();
  const rows = await db
    .select({
      permission: buyerRolePermissions.permission,
      accessLevel: buyerRolePermissions.accessLevel,
    })
    .from(buyerUserRoles)
    .innerJoin(buyerRolePermissions, eq(buyerRolePermissions.roleId, buyerUserRoles.roleId))
    .where(eq(buyerUserRoles.buyerUserId, id.data));
  return mergeBuyerGrants(
    rows.flatMap((r) =>
      isBuyerPermission(r.permission)
        ? [{ permission: r.permission, accessLevel: r.accessLevel }]
        : [],
    ),
  );
}
