import { z } from 'zod';
import { api } from './api.js';

// Requests to the admin API and the shapes of its answers, checked on arrival. The shapes
// mirror the modules' public types (identity, access, customers, catalog), which the browser
// bundle cannot import.

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

const customerGroupSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type CustomerGroup = z.infer<typeof customerGroupSchema>;

const buyerUserSchema = z.object({
  userId: z.string(),
  customerId: z.string(),
  createdAt: z.string(),
});
export type BuyerUser = z.infer<typeof buyerUserSchema>;

const invitationSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  email: z.string(),
  displayName: z.string(),
  invitedByUserId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;

const addressSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  label: z.string(),
  countryCode: z.string(),
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  regionCode: z.string(),
  postalCode: z.string(),
  gstin: z.string().nullable(),
  isDefaultBilling: z.boolean(),
  isDefaultShipping: z.boolean(),
});
export type Address = z.infer<typeof addressSchema>;

const buyerRoleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  isBuiltIn: z.boolean(),
  grants: z.array(z.object({ permission: z.string(), accessLevel: z.string() })),
});
export type BuyerRole = z.infer<typeof buyerRoleSchema>;
export type BuyerRoleGrant = BuyerRole['grants'][number];

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

const permissionSchema = z.object({ key: z.string(), description: z.string() });
export type PermissionInfo = z.infer<typeof permissionSchema>;

const productUnitSchema = z.object({ code: z.string(), name: z.string(), precision: z.number() });
export type ProductUnit = z.infer<typeof productUnitSchema>;

const attributeValueSchema = z.union([z.string(), z.boolean(), z.array(z.string())]);
export type AttributeValue = z.infer<typeof attributeValueSchema>;

const productSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.enum(['enabled', 'disabled']),
  categoryId: z.string().nullable(),
  attributes: z.record(z.string(), attributeValueSchema),
  primaryUnitCode: z.string(),
  units: z.array(productUnitSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
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
const categorySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  position: z.number(),
});

const nextAfter = z.string().nullable();

/** A page of an admin list: pass `nextAfter` back as `after` for the next one (ADR 0010). */
export interface Page<T> {
  items: T[];
  nextAfter: string | null;
}

export const PAGE_SIZES = [25, 50, 100] as const;
export const PAGE_SIZE = 25;

function pageQuery(after: string | undefined, limit: number) {
  return { after, limit: String(limit) };
}

async function page<T>(
  path: string,
  key: string,
  item: z.ZodType<T>,
  query: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
): Promise<Page<T>> {
  const schema = z.object({ items: z.array(item), nextAfter });
  const body = await api(
    path,
    z
      .record(z.string(), z.unknown())
      .transform((raw) => schema.parse({ items: raw[key], nextAfter: raw['nextAfter'] })),
    { query, signal },
  );
  return body;
}

const id = (value: string) => encodeURIComponent(value);
const none = z.undefined();

// Sign-in and session

export function signIn(email: string, password: string) {
  return api('/auth/sign-in', z.object({ user: adminUserSchema, expiresAt: z.string() }), {
    method: 'POST',
    body: { email, password },
  });
}

export function signOut() {
  return api('/auth/sign-out', none, { method: 'POST' });
}

export async function getMe(signal?: AbortSignal) {
  return (await api('/auth/me', z.object({ user: adminUserSchema }), { signal })).user;
}

export async function getMyPermissions(signal?: AbortSignal) {
  return (await api('/access/me', z.object({ permissions: z.array(z.string()) }), { signal }))
    .permissions;
}

// Customers

export function listCustomers(
  query: { after?: string | undefined; limit?: number; parentId?: string; groupId?: string },
  signal?: AbortSignal,
): Promise<Page<Customer>> {
  return page(
    '/customers',
    'customers',
    customerSchema,
    {
      ...pageQuery(query.after, query.limit ?? PAGE_SIZE),
      parentId: query.parentId,
      groupId: query.groupId,
    },
    signal,
  );
}

export async function getCustomer(customerId: string, signal?: AbortSignal) {
  return (
    await api(`/customers/${id(customerId)}`, z.object({ customer: customerSchema }), { signal })
  ).customer;
}

export async function createCustomer(input: {
  name: string;
  parentId: string | null;
  groupId: string | null;
}) {
  return (
    await api('/customers', z.object({ customer: customerSchema }), { method: 'POST', body: input })
  ).customer;
}

export async function setCustomerParent(customerId: string, parentId: string | null) {
  return (
    await api(`/customers/${id(customerId)}/parent`, z.object({ customer: customerSchema }), {
      method: 'PUT',
      body: { parentId },
    })
  ).customer;
}

export async function setCustomerGroup(customerId: string, groupId: string | null) {
  return (
    await api(`/customers/${id(customerId)}/group`, z.object({ customer: customerSchema }), {
      method: 'PUT',
      body: { groupId },
    })
  ).customer;
}

export function listSubsidiaries(
  customerId: string,
  after: string | undefined,
  signal?: AbortSignal,
  limit = 200,
): Promise<Page<Customer>> {
  return page(
    `/customers/${id(customerId)}/subsidiaries`,
    'customers',
    customerSchema,
    pageQuery(after, limit),
    signal,
  );
}

export function listCustomerGroups(
  after: string | undefined,
  signal?: AbortSignal,
  limit = 200,
): Promise<Page<CustomerGroup>> {
  return page(
    '/customers/groups',
    'customerGroups',
    customerGroupSchema,
    pageQuery(after, limit),
    signal,
  );
}

/** Every customer group, for pickers and names. There are few. */
export async function allCustomerGroups(signal?: AbortSignal): Promise<CustomerGroup[]> {
  const all: CustomerGroup[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const result = await listCustomerGroups(after, signal);
    all.push(...result.items);
    if (result.nextAfter === null) break;
    after = result.nextAfter;
  }
  return all;
}

export async function createCustomerGroup(input: { code: string; name: string }) {
  return (
    await api('/customers/groups', z.object({ customerGroup: customerGroupSchema }), {
      method: 'POST',
      body: input,
    })
  ).customerGroup;
}

export function listBuyerUsers(
  customerId: string,
  after: string | undefined,
  signal?: AbortSignal,
): Promise<Page<BuyerUser>> {
  return page(
    `/customers/${id(customerId)}/buyer-users`,
    'buyerUsers',
    buyerUserSchema,
    pageQuery(after, 100),
    signal,
  );
}

export async function createBuyerUser(
  customerId: string,
  input: { email: string; displayName: string; password?: string },
) {
  return (
    await api(
      `/customers/${id(customerId)}/buyer-users`,
      z.object({ buyerUser: buyerUserSchema }),
      {
        method: 'POST',
        body: input,
      },
    )
  ).buyerUser;
}

export async function linkBuyerUser(customerId: string, email: string) {
  return (
    await api(
      `/customers/${id(customerId)}/buyer-users/link`,
      z.object({ buyerUser: buyerUserSchema }),
      { method: 'POST', body: { email } },
    )
  ).buyerUser;
}

export function listInvitations(
  customerId: string,
  after: string | undefined,
  signal?: AbortSignal,
): Promise<Page<Invitation>> {
  return page(
    `/customers/${id(customerId)}/invitations`,
    'invitations',
    invitationSchema,
    pageQuery(after, 100),
    signal,
  );
}

/**
 * Invites a person. Until invitation emails exist (week 4) the answer carries the token once,
 * for the admin to pass on; the app shows it and never stores it.
 */
export function createInvitation(
  customerId: string,
  input: { email: string; displayName: string; expiresInHours?: number },
) {
  return api(
    `/customers/${id(customerId)}/invitations`,
    z.object({ invitation: invitationSchema, token: z.string() }),
    { method: 'POST', body: input },
  );
}

export async function revokeInvitation(invitationId: string) {
  return (
    await api(
      `/customers/invitations/${id(invitationId)}/revoke`,
      z.object({ invitation: invitationSchema }),
      {
        method: 'POST',
      },
    )
  ).invitation;
}

export function listAddresses(
  customerId: string,
  after: string | undefined,
  signal?: AbortSignal,
): Promise<Page<Address>> {
  return page(
    `/customers/${id(customerId)}/addresses`,
    'addresses',
    addressSchema,
    pageQuery(after, 100),
    signal,
  );
}

export interface NewAddress {
  countryCode: 'IN' | 'US';
  label: string;
  line1: string;
  line2: string;
  city: string;
  regionCode: string;
  postalCode: string;
  gstin: string | null;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
}

export async function addAddress(customerId: string, input: NewAddress) {
  return (
    await api(`/customers/${id(customerId)}/addresses`, z.object({ address: addressSchema }), {
      method: 'POST',
      body: input,
    })
  ).address;
}

// Access

export function listBuyerRoles(
  after: string | undefined,
  signal?: AbortSignal,
  limit = 200,
): Promise<Page<BuyerRole>> {
  return page(
    '/access/buyer-roles',
    'buyerRoles',
    buyerRoleSchema,
    pageQuery(after, limit),
    signal,
  );
}

/** Every buyer role with its grants. There are few, and the API has no single-role read yet. */
export async function allBuyerRoles(signal?: AbortSignal): Promise<BuyerRole[]> {
  const all: BuyerRole[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const result = await listBuyerRoles(after, signal);
    all.push(...result.items);
    if (result.nextAfter === null) break;
    after = result.nextAfter;
  }
  return all;
}

export async function getBuyerPermissions(signal?: AbortSignal) {
  return api(
    '/access/buyer-permissions',
    z.object({ permissions: z.array(permissionSchema), accessLevels: z.array(z.string()) }),
    { signal },
  );
}

export async function createBuyerRole(input: {
  code: string;
  name: string;
  description: string;
  grants: BuyerRoleGrant[];
}) {
  return (
    await api('/access/buyer-roles', z.object({ buyerRole: buyerRoleSchema }), {
      method: 'POST',
      body: input,
    })
  ).buyerRole;
}

export function setBuyerRoleGrants(roleId: string, grants: BuyerRoleGrant[]) {
  return api(`/access/buyer-roles/${id(roleId)}/grants`, none, { method: 'PUT', body: { grants } });
}

export function deleteBuyerRole(roleId: string) {
  return api(`/access/buyer-roles/${id(roleId)}`, none, { method: 'DELETE' });
}

export function assignBuyerRole(userId: string, roleId: string) {
  return api(`/access/buyer-users/${id(userId)}/buyer-roles/${id(roleId)}`, none, {
    method: 'PUT',
  });
}

export async function listAdminRoles(signal?: AbortSignal) {
  return (await api('/access/roles', z.object({ roles: z.array(adminRoleSchema) }), { signal }))
    .roles;
}

export async function getAdminPermissions(signal?: AbortSignal) {
  return (
    await api('/access/permissions', z.object({ permissions: z.array(permissionSchema) }), {
      signal,
    })
  ).permissions;
}

export async function createAdminRole(input: {
  code: string;
  name: string;
  description: string;
  permissions: string[];
}) {
  return (
    await api('/access/roles', z.object({ role: adminRoleSchema }), { method: 'POST', body: input })
  ).role;
}

export function setAdminRolePermissions(roleId: string, permissions: string[]) {
  return api(`/access/roles/${id(roleId)}/permissions`, none, {
    method: 'PUT',
    body: { permissions },
  });
}

export function deleteAdminRole(roleId: string) {
  return api(`/access/roles/${id(roleId)}`, none, { method: 'DELETE' });
}

// Catalog

export function listProducts(
  query: {
    after?: string | undefined;
    limit?: number;
    categoryId?: string | undefined;
    status?: string | undefined;
  },
  signal?: AbortSignal,
): Promise<Page<Product>> {
  return page(
    '/catalog/products',
    'products',
    productSchema,
    {
      ...pageQuery(query.after, query.limit ?? PAGE_SIZE),
      categoryId: query.categoryId,
      includeSubcategories: query.categoryId === undefined ? undefined : 'true',
      status: query.status,
    },
    signal,
  );
}

export async function getProduct(productId: string, signal?: AbortSignal) {
  return (
    await api(`/catalog/products/${id(productId)}`, z.object({ product: productSchema }), {
      signal,
    })
  ).product;
}

export async function createProduct(input: {
  sku: string;
  name: string;
  status: 'enabled' | 'disabled';
  categoryId: string | null;
  primaryUnitCode: string;
}) {
  return (
    await api('/catalog/products', z.object({ product: productSchema }), {
      method: 'POST',
      body: input,
    })
  ).product;
}

export async function updateProduct(
  productId: string,
  changes: Partial<Pick<Product, 'sku' | 'name' | 'status' | 'categoryId' | 'attributes'>>,
) {
  return (
    await api(`/catalog/products/${id(productId)}`, z.object({ product: productSchema }), {
      method: 'PATCH',
      body: changes,
    })
  ).product;
}

export async function setProductUnits(
  productId: string,
  units: { primaryUnitCode: string; additionalUnitCodes: string[] },
) {
  return (
    await api(`/catalog/products/${id(productId)}/units`, z.object({ product: productSchema }), {
      method: 'PUT',
      body: units,
    })
  ).product;
}

export async function listProductUnits(signal?: AbortSignal) {
  return (
    await api('/catalog/product-units', z.object({ productUnits: z.array(productUnitSchema) }), {
      signal,
    })
  ).productUnits;
}

export async function createProductUnit(input: ProductUnit) {
  return (
    await api('/catalog/product-units', z.object({ productUnit: productUnitSchema }), {
      method: 'POST',
      body: input,
    })
  ).productUnit;
}

export async function listCategories(signal?: AbortSignal) {
  return (
    await api('/catalog/categories', z.object({ categories: z.array(categoryNodeSchema) }), {
      signal,
    })
  ).categories;
}

export async function createCategory(input: {
  code: string;
  name: string;
  parentId: string | null;
  position: number;
}) {
  return (
    await api('/catalog/categories', z.object({ category: categorySchema }), {
      method: 'POST',
      body: input,
    })
  ).category;
}

export async function updateCategory(
  categoryId: string,
  changes: { name?: string; position?: number },
) {
  return (
    await api(`/catalog/categories/${id(categoryId)}`, z.object({ category: categorySchema }), {
      method: 'PATCH',
      body: changes,
    })
  ).category;
}

export async function setCategoryParent(categoryId: string, parentId: string | null) {
  return (
    await api(
      `/catalog/categories/${id(categoryId)}/parent`,
      z.object({ category: categorySchema }),
      {
        method: 'PUT',
        body: { parentId },
      },
    )
  ).category;
}

export function deleteCategory(categoryId: string) {
  return api(`/catalog/categories/${id(categoryId)}`, none, { method: 'DELETE' });
}
