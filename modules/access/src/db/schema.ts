import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Tables owned by the access module. Other modules must not query these directly.
//
// User ids refer to identity users. There is no foreign key, because a module never touches
// another module's tables; the realm is checked through identity's public interface before a
// role is assigned (ADR 0006).

/** Buyer role access levels, narrowest first. Must match ACCESS_LEVELS in permissions.ts. */
export const accessLevel = pgEnum('access_level', [
  'own_records',
  'my_customer',
  'my_customer_and_subsidiaries',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const roleCodeShape = (column: AnyPgColumn) => sql`${column} ~ '^[a-z][a-z0-9_]{1,62}$'`;
const permissionShape = (column: AnyPgColumn) =>
  sql`${column} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`;

/** A named set of admin permissions, for example "Sales manager". */
export const adminRoles = pgTable(
  'access_admin_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Built-in roles are seeded by the system and cannot be edited or deleted. */
    isBuiltIn: boolean('is_built_in').notNull().default(false),
    /** Grants every admin permission, including ones added later. Built-in roles only. */
    grantsAllPermissions: boolean('grants_all_permissions').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check('access_admin_role_code_format', roleCodeShape(t.code)),
    check(
      'access_admin_role_grants_all_built_in',
      sql`not ${t.grantsAllPermissions} or ${t.isBuiltIn}`,
    ),
  ],
);

export const adminRolePermissions = pgTable(
  'access_admin_role_permission',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => adminRoles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [
    primaryKey({ name: 'access_admin_role_permission_pk', columns: [t.roleId, t.permission] }),
    check('access_admin_role_permission_format', permissionShape(t.permission)),
  ],
);

export const adminUserRoles = pgTable(
  'access_admin_user_role',
  {
    adminUserId: uuid('admin_user_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => adminRoles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'access_admin_user_role_pk', columns: [t.adminUserId, t.roleId] }),
    index('access_admin_user_role_role_idx').on(t.roleId),
  ],
);

/** A buyer role: storefront permissions, each with an access level. */
export const buyerRoles = pgTable(
  'access_buyer_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isBuiltIn: boolean('is_built_in').notNull().default(false),
    ...timestamps,
  },
  (t) => [check('access_buyer_role_code_format', roleCodeShape(t.code))],
);

export const buyerRolePermissions = pgTable(
  'access_buyer_role_permission',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => buyerRoles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    accessLevel: accessLevel('access_level').notNull(),
  },
  (t) => [
    // One access level per permission per role.
    primaryKey({ name: 'access_buyer_role_permission_pk', columns: [t.roleId, t.permission] }),
    check('access_buyer_role_permission_format', permissionShape(t.permission)),
  ],
);

export const buyerUserRoles = pgTable(
  'access_buyer_user_role',
  {
    buyerUserId: uuid('buyer_user_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => buyerRoles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'access_buyer_user_role_pk', columns: [t.buyerUserId, t.roleId] }),
    index('access_buyer_user_role_role_idx').on(t.roleId),
  ],
);
