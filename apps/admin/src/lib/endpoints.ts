import { z } from 'zod';
import { api } from './api.js';

// Response shapes of the admin API, checked on arrival. They mirror the modules' public types
// (identity, access, customers, catalog), which the browser bundle cannot import.

const adminUserSchema = z.object({
  id: z.string(),
  realm: z.literal('admin'),
  email: z.string(),
  displayName: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  groupId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

const buyerRoleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  isBuiltIn: z.boolean(),
  grants: z.array(z.object({ permission: z.string(), accessLevel: z.string() })),
});
export type BuyerRole = z.infer<typeof buyerRoleSchema>;

const adminRoleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  isBuiltIn: z.boolean(),
  grantsAllPermissions: z.boolean(),
  permissions: z.array(z.string()),
});
export type AdminRole = z.infer<typeof adminRoleSchema>;

const productSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  categoryId: z.string().nullable(),
  primaryUnitCode: z.string(),
  units: z.array(z.object({ code: z.string(), name: z.string(), precision: z.number() })),
});
export type Product = z.infer<typeof productSchema>;

export interface CategoryNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  position: number;
  children: CategoryNode[];
}
const categoryNodeSchema: z.ZodType<CategoryNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
    position: z.number(),
    children: z.array(categoryNodeSchema),
  }),
);

const nextAfter = z.string().nullable();

/** A page of an admin list: pass `nextAfter` back as `after` for the next one (ADR 0010). */
export interface Page<T> {
  items: T[];
  nextAfter: string | null;
}

export const PAGE_SIZE = 50;

function pageQuery(after: string | undefined, limit = PAGE_SIZE) {
  return { after, limit: String(limit) };
}

// Sign-in and session

export function signIn(email: string, password: string) {
  return api('/auth/sign-in', z.object({ user: adminUserSchema, expiresAt: z.string() }), {
    method: 'POST',
    body: { email, password },
  });
}

export function signOut() {
  return api('/auth/sign-out', z.undefined(), { method: 'POST' });
}

export async function getMe(signal?: AbortSignal) {
  return (await api('/auth/me', z.object({ user: adminUserSchema }), { signal })).user;
}

export async function getMyPermissions(signal?: AbortSignal) {
  return (await api('/access/me', z.object({ permissions: z.array(z.string()) }), { signal }))
    .permissions;
}

// Customers

export async function listCustomers(
  query: { after?: string | undefined; parentId?: string; topLevel?: boolean },
  signal?: AbortSignal,
): Promise<Page<Customer>> {
  const page = await api(
    '/customers',
    z.object({ customers: z.array(customerSchema), nextAfter }),
    {
      query: {
        ...pageQuery(query.after),
        parentId: query.parentId,
        topLevel: query.topLevel === undefined ? undefined : String(query.topLevel),
      },
      signal,
    },
  );
  return { items: page.customers, nextAfter: page.nextAfter };
}

export async function getCustomer(customerId: string, signal?: AbortSignal) {
  const path = `/customers/${encodeURIComponent(customerId)}`;
  return (await api(path, z.object({ customer: customerSchema }), { signal })).customer;
}

export async function listSubsidiaries(
  customerId: string,
  after: string | undefined,
  signal?: AbortSignal,
): Promise<Page<Customer>> {
  const page = await api(
    `/customers/${encodeURIComponent(customerId)}/subsidiaries`,
    z.object({ customers: z.array(customerSchema), nextAfter }),
    { query: pageQuery(after), signal },
  );
  return { items: page.customers, nextAfter: page.nextAfter };
}

// Access

export async function listBuyerRoles(
  after: string | undefined,
  signal?: AbortSignal,
  limit = PAGE_SIZE,
): Promise<Page<BuyerRole>> {
  const page = await api(
    '/access/buyer-roles',
    z.object({ buyerRoles: z.array(buyerRoleSchema), nextAfter }),
    { query: pageQuery(after, limit), signal },
  );
  return { items: page.buyerRoles, nextAfter: page.nextAfter };
}

export async function listAdminRoles(signal?: AbortSignal) {
  return (await api('/access/roles', z.object({ roles: z.array(adminRoleSchema) }), { signal }))
    .roles;
}

// Catalog

export async function listProducts(
  after: string | undefined,
  signal?: AbortSignal,
): Promise<Page<Product>> {
  const page = await api(
    '/catalog/products',
    z.object({ products: z.array(productSchema), nextAfter }),
    { query: pageQuery(after), signal },
  );
  return { items: page.products, nextAfter: page.nextAfter };
}

export async function listCategories(signal?: AbortSignal) {
  return (
    await api('/catalog/categories', z.object({ categories: z.array(categoryNodeSchema) }), {
      signal,
    })
  ).categories;
}

/**
 * One buyer role with its grants. The API has no single-role read yet, so this pages through
 * the list (200 at a time); there are few buyer roles. Undefined when no role has the id.
 */
export async function findBuyerRole(
  roleId: string,
  signal?: AbortSignal,
): Promise<BuyerRole | undefined> {
  let after: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await listBuyerRoles(after, signal, 200);
    const role = page.items.find((item) => item.id === roleId);
    if (role) return role;
    if (page.nextAfter === null) return undefined;
    after = page.nextAfter;
  }
  return undefined;
}
