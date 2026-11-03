import { z } from 'zod';
import { API_PREFIX, api } from './api.js';

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
  buyerRoleId: z.string().nullable(),
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
  /** India: HSN (goods) or SAC (services); null until set. */
  hsnSacCode: z.string().nullable().default(null),
  /** US: general or exempt; null is taxable, like general. */
  usTaxCategory: z.enum(['general', 'exempt']).nullable().default(null),
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

/** Invites a person. The API emails the accept link (ADR 0020); the app never sees the token. */
export function createInvitation(
  customerId: string,
  input: {
    email: string;
    displayName: string;
    expiresInHours?: number;
    /** null for none; left out for the default buyer role setting. */
    buyerRoleId?: string | null;
  },
) {
  return api(
    `/customers/${id(customerId)}/invitations`,
    z.object({ invitation: invitationSchema }),
    { method: 'POST', body: input },
  );
}

/** Emails a new link for an invitation; the old link stops working. */
export async function resendInvitation(invitationId: string) {
  return (
    await api(
      `/customers/invitations/${id(invitationId)}/resend`,
      z.object({ invitation: invitationSchema }),
      { method: 'POST' },
    )
  ).invitation;
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
    missingTaxCode?: boolean | undefined;
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
      missingTaxCode: query.missingTaxCode ? 'true' : undefined,
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
  changes: Partial<
    Pick<
      Product,
      'sku' | 'name' | 'status' | 'categoryId' | 'attributes' | 'hsnSacCode' | 'usTaxCategory'
    >
  >,
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

// Orders (ADR 0016)

export const ORDER_STEPS = ['new', 'confirmed', 'processing', 'completed', 'declined'] as const;
export type OrderStep = (typeof ORDER_STEPS)[number];

const orderSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  websiteId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  placedBy: z.string(),
  step: z.enum(ORDER_STEPS),
  purchaseOrderNumber: z.string().nullable(),
  grandTotal: z.string(),
  currency: z.string(),
  placedAt: z.string(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

const orderAddressSchema = z.object({
  label: z.string(),
  countryCode: z.string(),
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  regionCode: z.string(),
  postalCode: z.string(),
  gstin: z.string().nullable(),
});
export type OrderAddress = z.infer<typeof orderAddressSchema>;

export const PAYMENT_METHODS = ['terms', 'stripe', 'razorpay'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const orderSchema = orderSummarySchema.extend({
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentTermDays: z.number(),
  /** Null when the order is paid online (ADR 0019). */
  dueOn: z.string().nullable(),
  shippingMethod: z.string(),
  taxProvider: z.string(),
  sellerTaxId: z.string().nullable(),
  taxExemptionCertificate: z.string().nullable(),
  subtotal: z.string(),
  discount: z.string(),
  shipping: z.string(),
  shippingDiscount: z.string(),
  tax: z.string(),
  lines: z.array(
    z.object({
      lineNo: z.number(),
      productId: z.string(),
      sku: z.string(),
      productName: z.string(),
      unitCode: z.string(),
      unitName: z.string(),
      quantity: z.string(),
      unitPrice: z.string(),
      subtotal: z.string(),
      discount: z.string(),
      net: z.string(),
      taxCode: z.string().nullable(),
    }),
  ),
  taxes: z.array(
    z.object({
      lineNo: z.number().nullable(),
      name: z.string(),
      rate: z.string(),
      taxable: z.string(),
      amount: z.string(),
    }),
  ),
  billingAddress: orderAddressSchema,
  shippingAddress: orderAddressSchema,
});
export type Order = z.infer<typeof orderSchema>;

/**
 * An online payment and what the gateway said about it (ADR 0019). Before the buyer presses
 * Pay now there is no gateway record yet: `started` is false.
 */
const orderPaymentSchema = z.union([
  z.object({ status: z.literal('pending'), started: z.literal(false), amount: z.string() }),
  z.object({
    status: z.enum(PAYMENT_STATUSES),
    started: z.literal(true),
    gateway: z.enum(['stripe', 'razorpay']),
    gatewayRef: z.string().nullable(),
    amount: z.string(),
    refunded: z.string(),
    paidAt: z.string().nullable(),
    transactions: z.array(
      z.object({
        eventId: z.string(),
        eventType: z.string(),
        amount: z.string().nullable(),
        outcome: z.string(),
        statusAfter: z.string().nullable(),
        receivedAt: z.string(),
      }),
    ),
  }),
]);
export type OrderPayment = z.infer<typeof orderPaymentSchema>;

const orderViewSchema = z.object({
  order: orderSchema,
  payment: orderPaymentSchema.nullable(),
  version: z.number(),
  transitions: z.array(z.string()),
  history: z.array(
    z.object({
      sequence: z.number(),
      transition: z.string().nullable(),
      fromStep: z.string().nullable(),
      toStep: z.string(),
      actor: z.object({ type: z.string(), id: z.string().nullable().optional() }),
      note: z.string().nullable(),
      occurredAt: z.string(),
    }),
  ),
});
export type OrderView = z.infer<typeof orderViewSchema>;

export function listOrders(
  query: {
    after?: string | undefined;
    limit?: number;
    step?: OrderStep | undefined;
    customerId?: string | undefined;
  },
  signal?: AbortSignal,
): Promise<Page<OrderSummary>> {
  return page(
    '/orders',
    'orders',
    orderSummarySchema,
    {
      ...pageQuery(query.after, query.limit ?? PAGE_SIZE),
      step: query.step,
      customerId: query.customerId,
    },
    signal,
  );
}

export function getOrder(orderId: string, signal?: AbortSignal): Promise<OrderView> {
  return api(`/orders/${id(orderId)}`, orderViewSchema, { signal });
}

export function transitionOrder(
  orderId: string,
  input: { transition: string; note?: string; expectedVersion: number },
): Promise<OrderView> {
  return api(`/orders/${id(orderId)}/transitions`, orderViewSchema, {
    method: 'POST',
    body: input,
  });
}

// Emails (ADR 0020)

export const EMAIL_STATUSES = ['queued', 'sent', 'failed'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const emailSchema = z.object({
  id: z.string(),
  kind: z.string(),
  recipient: z.string(),
  locale: z.string(),
  subject: z.string(),
  status: z.enum(EMAIL_STATUSES),
  attempts: z.number(),
  nextAttemptAt: z.string(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type OutboxEmail = z.infer<typeof emailSchema>;

/** Emails, newest first, without their bodies. */
export function listEmails(
  query: { after?: string | undefined; limit?: number; status?: EmailStatus | undefined },
  signal?: AbortSignal,
): Promise<Page<OutboxEmail>> {
  return page(
    '/notifications',
    'emails',
    emailSchema,
    { ...pageQuery(query.after, query.limit ?? PAGE_SIZE), status: query.status },
    signal,
  );
}

/** Queues a failed email again, from its first attempt. */
export async function retryEmail(emailId: string): Promise<OutboxEmail> {
  return (
    await api(`/notifications/${id(emailId)}/retry`, z.object({ email: emailSchema }), {
      method: 'POST',
    })
  ).email;
}

// Websites (ADR 0021)

const websiteSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
  defaultCurrency: z.string(),
  defaultLocale: z.string(),
  timeZone: z.string(),
  unitSystem: z.enum(['metric', 'imperial']),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type Website = z.infer<typeof websiteSchema>;

/** Every website, by code; any signed-in admin may list them. */
export async function listWebsites(signal?: AbortSignal): Promise<Website[]> {
  return (await api('/websites', z.object({ websites: z.array(websiteSchema) }), { signal }))
    .websites;
}

export async function createWebsite(input: {
  code: string;
  name: string;
  countryCode: string;
  defaultCurrency: string;
  defaultLocale: string;
  timeZone: string;
  unitSystem: 'metric' | 'imperial';
}): Promise<Website> {
  return (
    await api('/websites', z.object({ website: websiteSchema }), { method: 'POST', body: input })
  ).website;
}

/** Code, country and currency are fixed; the rest can change. */
export async function updateWebsite(
  websiteId: string,
  changes: Partial<
    Pick<Website, 'name' | 'defaultLocale' | 'timeZone' | 'unitSystem' | 'isActive'>
  >,
): Promise<Website> {
  return (
    await api(`/websites/${id(websiteId)}`, z.object({ website: websiteSchema }), {
      method: 'PATCH',
      body: changes,
    })
  ).website;
}

// Settings (ADR 0021)

export const SCOPE_TYPES = [
  'customer',
  'customer_group',
  'website',
  'organization',
  'global',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

const editorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('integer'),
    min: z.number(),
    max: z.number(),
    unit: z.string().optional(),
  }),
  z.object({ kind: z.literal('money') }),
  z.object({ kind: z.literal('text'), pattern: z.string().optional() }),
  z.object({ kind: z.literal('email'), allowEmpty: z.boolean() }),
  z.object({
    kind: z.literal('choices'),
    multiple: z.boolean(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  }),
  z.object({ kind: z.literal('boolean') }),
  z.object({ kind: z.literal('buyer_role') }),
]);
export type SettingEditor = z.infer<typeof editorSchema>;

const settingSchema = z.object({
  key: z.string(),
  group: z.string(),
  label: z.string(),
  description: z.string(),
  editor: editorSchema,
  allowedScopes: z.array(z.enum(SCOPE_TYPES)),
  defaultValue: z.unknown(),
  value: z.unknown(),
  source: z.enum([...SCOPE_TYPES, 'default']),
});
export type Setting = z.infer<typeof settingSchema>;

export interface SettingContext {
  websiteId?: string | undefined;
  customerGroupId?: string | undefined;
  customerId?: string | undefined;
}

/** Every setting an admin may change, with its effective value and source for the context. */
export async function listSettings(
  context: SettingContext,
  signal?: AbortSignal,
): Promise<Setting[]> {
  return (
    await api('/settings', z.object({ settings: z.array(settingSchema) }), {
      signal,
      query: {
        websiteId: context.websiteId,
        customerGroupId: context.customerGroupId,
        customerId: context.customerId,
      },
    })
  ).settings;
}

/** Overrides a setting at one scope; organization and global take no id. */
export async function setSettingValue(
  key: string,
  scope: { type: ScopeType; id?: string },
  value: unknown,
): Promise<void> {
  await api(`/settings/${id(key)}`, z.unknown(), { method: 'PUT', body: { scope, value } });
}

/** Clears an override, so the setting falls back to the next scope. */
export async function clearSettingValue(
  key: string,
  scope: { type: ScopeType; id?: string },
): Promise<void> {
  await api(`/settings/${id(key)}`, z.unknown(), {
    method: 'DELETE',
    query: { scope: scope.type, scopeId: scope.id },
  });
}

// Pricing (ADR 0011, screens in ADR 0022)

export const PRICE_LIST_STATUSES = ['scheduled', 'active', 'expired'] as const;
export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];

const priceListSchema = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string(),
  activeFrom: z.string().nullable(),
  activeUntil: z.string().nullable(),
  status: z.enum(PRICE_LIST_STATUSES),
  priceCount: z.number().optional(),
  assignmentCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PriceList = z.infer<typeof priceListSchema>;

const priceSchema = z.object({
  id: z.string(),
  priceListId: z.string(),
  productId: z.string(),
  sku: z.string().nullable(),
  productName: z.string().nullable(),
  unitCode: z.string(),
  minQuantity: z.string(),
  amount: z.string(),
  currency: z.string(),
});
export type Price = z.infer<typeof priceSchema>;

export const ASSIGNMENT_TARGETS = ['customer', 'customer_group', 'website'] as const;
export type AssignmentTarget = (typeof ASSIGNMENT_TARGETS)[number];

const assignmentSchema = z.object({
  id: z.string(),
  priceListId: z.string(),
  websiteId: z.string(),
  websiteName: z.string().nullable().optional(),
  target: z.enum(ASSIGNMENT_TARGETS),
  targetId: z.string(),
  targetName: z.string().nullable().optional(),
  priority: z.number(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export function listPriceLists(
  query: { after?: string | undefined; limit?: number | undefined; currency?: string | undefined },
  signal?: AbortSignal,
): Promise<Page<PriceList>> {
  return page(
    '/pricing/price-lists',
    'priceLists',
    priceListSchema,
    { ...pageQuery(query.after, query.limit ?? PAGE_SIZE), currency: query.currency },
    signal,
  );
}

export async function getPriceList(priceListId: string, signal?: AbortSignal) {
  return (
    await api(`/pricing/price-lists/${id(priceListId)}`, z.object({ priceList: priceListSchema }), {
      signal,
    })
  ).priceList;
}

export async function createPriceList(input: {
  name: string;
  currency: string;
  activeFrom: string | null;
  activeUntil: string | null;
}) {
  return (
    await api('/pricing/price-lists', z.object({ priceList: priceListSchema }), {
      method: 'POST',
      body: input,
    })
  ).priceList;
}

export async function updatePriceList(
  priceListId: string,
  changes: { name?: string; activeFrom?: string | null; activeUntil?: string | null },
) {
  return (
    await api(`/pricing/price-lists/${id(priceListId)}`, z.object({ priceList: priceListSchema }), {
      method: 'PATCH',
      body: changes,
    })
  ).priceList;
}

export function deletePriceList(priceListId: string) {
  return api(`/pricing/price-lists/${id(priceListId)}`, none, { method: 'DELETE' });
}

export function listPrices(
  priceListId: string,
  query: {
    after?: string | undefined;
    limit?: number | undefined;
    q?: string | undefined;
    unitCode?: string | undefined;
  },
  signal?: AbortSignal,
): Promise<Page<Price>> {
  return page(
    `/pricing/price-lists/${id(priceListId)}/prices`,
    'prices',
    priceSchema,
    {
      ...pageQuery(query.after, query.limit ?? PAGE_SIZE),
      q: query.q,
      unitCode: query.unitCode,
    },
    signal,
  );
}

export async function addPrice(
  priceListId: string,
  input: { productId: string; unitCode: string; minQuantity: string; amount: string },
) {
  return (
    await api(`/pricing/price-lists/${id(priceListId)}/prices`, z.object({ price: priceSchema }), {
      method: 'POST',
      body: input,
    })
  ).price;
}

export async function updatePrice(priceId: string, amount: string) {
  return (
    await api(`/pricing/prices/${id(priceId)}`, z.object({ price: priceSchema }), {
      method: 'PATCH',
      body: { amount },
    })
  ).price;
}

export function deletePrice(priceId: string) {
  return api(`/pricing/prices/${id(priceId)}`, none, { method: 'DELETE' });
}

const importResultSchema = z.object({
  added: z.number(),
  updated: z.number(),
  skipped: z.array(
    z.object({ row: z.number(), sku: z.string(), code: z.string(), message: z.string() }),
  ),
});
export type PriceImportResult = z.infer<typeof importResultSchema>;

/** Imports prices from CSV: all rows, or with skipInvalid only the valid ones. */
export function importPrices(priceListId: string, csv: string, skipInvalid: boolean) {
  return api(`/pricing/price-lists/${id(priceListId)}/prices/import`, importResultSchema, {
    method: 'POST',
    csv,
    query: { skipInvalid: skipInvalid ? 'true' : undefined },
  });
}

/** Where the browser downloads a price list's prices as CSV; the session cookie goes along. */
export function pricesCsvUrl(priceListId: string): string {
  return `${API_PREFIX}/pricing/price-lists/${id(priceListId)}/prices.csv`;
}

export async function listAssignments(
  query: { priceListId?: string; target?: AssignmentTarget; targetId?: string },
  signal?: AbortSignal,
): Promise<Assignment[]> {
  return (
    await page(
      '/pricing/assignments',
      'assignments',
      assignmentSchema,
      {
        ...pageQuery(undefined, 200),
        priceListId: query.priceListId,
        target: query.target,
        targetId: query.targetId,
      },
      signal,
    )
  ).items;
}

export async function createAssignment(input: {
  priceListId: string;
  websiteId: string;
  target: AssignmentTarget;
  /** Left out for a website target. */
  targetId?: string;
  /** Left out to come after the target's other price lists. */
  priority?: number;
}) {
  return (
    await api('/pricing/assignments', z.object({ assignment: assignmentSchema }), {
      method: 'POST',
      body: input,
    })
  ).assignment;
}

export async function updateAssignment(assignmentId: string, priority: number) {
  return (
    await api(
      `/pricing/assignments/${id(assignmentId)}`,
      z.object({ assignment: assignmentSchema }),
      {
        method: 'PATCH',
        body: { priority },
      },
    )
  ).assignment;
}

export function deleteAssignment(assignmentId: string) {
  return api(`/pricing/assignments/${id(assignmentId)}`, none, { method: 'DELETE' });
}

const buildSchema = z.object({
  pendingChanges: z.number(),
  lastBuild: z.object({ builtAt: z.string(), builtBy: z.string().nullable() }).nullable(),
});
export type PriceBuildState = z.infer<typeof buildSchema>;

export async function getPriceBuild(signal?: AbortSignal) {
  return (await api('/pricing/build', z.object({ build: buildSchema }), { signal })).build;
}

/** Builds the combined prices now and waits for it (ADR 0011). */
export function buildPrices() {
  return api('/pricing/build', z.unknown(), { method: 'POST' });
}

const visibilityBuildSchema = z.object({
  pendingChanges: z.number(),
  catalogChangedSinceBuild: z.boolean(),
  lastBuild: z
    .object({
      builtAt: z.string(),
      builtBy: z.string().nullable(),
      visibleProductCount: z.number(),
    })
    .nullable(),
});
export type VisibilityBuildState = z.infer<typeof visibilityBuildSchema>;

export async function getVisibilityBuild(signal?: AbortSignal) {
  return (await api('/visibility/build', z.object({ build: visibilityBuildSchema }), { signal }))
    .build;
}

/** Builds what each buyer may see now and waits for it (ADR 0012). */
export function buildVisibility() {
  return api('/visibility/build', z.unknown(), { method: 'POST' });
}

const tierSchema = z.object({ minQuantity: z.string(), unitPrice: z.string() });

const previewSchema = z.object({
  currency: z.string(),
  quantity: z.string(),
  price: z
    .object({ unitPrice: z.string(), minQuantity: z.string(), priceListId: z.string() })
    .nullable(),
  lineAmount: z.string().nullable(),
  reason: z.string().nullable(),
  steps: z.array(
    z.object({
      target: z.enum(ASSIGNMENT_TARGETS),
      targetId: z.string(),
      priority: z.number(),
      priceListId: z.string(),
      priceListName: z.string(),
      status: z.string(),
      tier: tierSchema.nullable(),
    }),
  ),
  unbuiltPrice: z
    .object({ unitPrice: z.string(), minQuantity: z.string(), priceListId: z.string() })
    .nullable(),
  pendingChanges: z.number(),
});
export type PricePreview = z.infer<typeof previewSchema>;

export async function previewPrice(
  query: {
    customerId: string;
    websiteId: string;
    productId: string;
    unitCode: string;
    quantity: string;
  },
  signal?: AbortSignal,
) {
  return (await api('/pricing/preview', z.object({ preview: previewSchema }), { query, signal }))
    .preview;
}

const searchHitSchema = z.object({ productId: z.string(), sku: z.string(), name: z.string() });
export type ProductHit = z.infer<typeof searchHitSchema>;

/** The admin product search, for pickers: SKU, then name. */
export async function searchProducts(q: string, signal?: AbortSignal): Promise<ProductHit[]> {
  return (
    await api('/search/products', z.object({ results: z.array(searchHitSchema) }), {
      query: { q, limit: '10' },
      signal,
    })
  ).results;
}

// Tax (ADR 0017, screens in ADR 0023)

const registrationSchema = z.object({
  id: z.string(),
  websiteId: z.string(),
  regime: z.enum(['gst', 'us_sales_tax']),
  /** The GST state code ("27") or the US state ("TX"). */
  regionCode: z.string(),
  number: z.string(),
});
export type TaxRegistration = z.infer<typeof registrationSchema>;

const ratePeriod = { validFrom: z.string(), validTo: z.string().nullable() };
const gstRateSchema = z.object({
  id: z.string(),
  codePrefix: z.string(),
  ratePercent: z.string(),
  ...ratePeriod,
});
export type GstRate = z.infer<typeof gstRateSchema>;
const usRateSchema = z.object({
  id: z.string(),
  stateCode: z.string(),
  zipPrefix: z.string().nullable(),
  ratePercent: z.string(),
  shippingTaxable: z.boolean(),
  ...ratePeriod,
});
export type UsRate = z.infer<typeof usRateSchema>;
const exemptionSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  stateCode: z.string(),
  certificateNumber: z.string(),
  expiresOn: z.string().nullable(),
});
export type Exemption = z.infer<typeof exemptionSchema>;

const readinessItemSchema = z.object({
  code: z.string(),
  ok: z.boolean(),
  count: z.number(),
  examples: z.array(z.record(z.string(), z.unknown())),
});
const readinessSchema = z.object({
  websiteId: z.string(),
  countryCode: z.string(),
  day: z.string(),
  ready: z.boolean(),
  items: z.array(readinessItemSchema),
});
export type TaxReadiness = z.infer<typeof readinessSchema>;

/** What would refuse checkout on a website today. */
export async function getTaxReadiness(websiteId: string, signal?: AbortSignal) {
  return (
    await api('/tax/readiness', z.object({ readiness: readinessSchema }), {
      query: { websiteId },
      signal,
    })
  ).readiness;
}

export async function listTaxRegistrations(websiteId: string, signal?: AbortSignal) {
  return (
    await api(
      `/tax/websites/${id(websiteId)}/registrations`,
      z.object({ registrations: z.array(registrationSchema) }),
      { signal },
    )
  ).registrations;
}

export async function setGstRegistration(websiteId: string, gstin: string) {
  return (
    await api(
      `/tax/websites/${id(websiteId)}/gst-registration`,
      z.object({ registration: registrationSchema }),
      { method: 'PUT', body: { gstin } },
    )
  ).registration;
}

export async function addUsRegistration(
  websiteId: string,
  input: { stateCode: string; permitNumber: string },
) {
  return (
    await api(
      `/tax/websites/${id(websiteId)}/us-registrations`,
      z.object({ registration: registrationSchema }),
      { method: 'POST', body: input },
    )
  ).registration;
}

export function deleteTaxRegistration(registrationId: string) {
  return api(`/tax/registrations/${id(registrationId)}`, none, { method: 'DELETE' });
}

export async function listGstRates(query: { on?: string | undefined }, signal?: AbortSignal) {
  return (
    await api('/tax/gst-rates', z.object({ rates: z.array(gstRateSchema) }), {
      query: { on: query.on },
      signal,
    })
  ).rates;
}

export async function addGstRate(input: {
  codePrefix: string;
  ratePercent: string;
  validFrom: string;
  validTo: string | null;
}) {
  return (
    await api('/tax/gst-rates', z.object({ rate: gstRateSchema }), { method: 'POST', body: input })
  ).rate;
}

export async function listUsRates(
  query: { on?: string | undefined; stateCode?: string | undefined },
  signal?: AbortSignal,
) {
  return (
    await api('/tax/us-rates', z.object({ rates: z.array(usRateSchema) }), {
      query: { on: query.on, stateCode: query.stateCode },
      signal,
    })
  ).rates;
}

export async function addUsRate(input: {
  stateCode: string;
  zipPrefix: string | null;
  ratePercent: string;
  shippingTaxable: boolean;
  validFrom: string;
  validTo: string | null;
}) {
  return (
    await api('/tax/us-rates', z.object({ rate: usRateSchema }), { method: 'POST', body: input })
  ).rate;
}

/** Sets the day a rate stops applying (exclusive), or null for no end. */
export function endTaxRate(kind: 'gst' | 'us', rateId: string, validTo: string | null) {
  return api(`/tax/${kind}-rates/${id(rateId)}`, z.unknown(), {
    method: 'PATCH',
    body: { validTo },
  });
}

export function deleteTaxRate(kind: 'gst' | 'us', rateId: string) {
  return api(`/tax/${kind}-rates/${id(rateId)}`, none, { method: 'DELETE' });
}

/** Imports US rates from CSV: every row, or none. */
export function importUsRates(csv: string) {
  return api('/tax/us-rates/import', z.object({ imported: z.number() }), { method: 'POST', csv });
}

export async function listExemptions(query: { customerId?: string }, signal?: AbortSignal) {
  return (
    await api('/tax/exemptions', z.object({ exemptions: z.array(exemptionSchema) }), {
      query: { customerId: query.customerId },
      signal,
    })
  ).exemptions;
}

export async function addExemption(input: {
  customerId: string;
  stateCode: string;
  certificateNumber: string;
  expiresOn: string | null;
}) {
  return (
    await api('/tax/exemptions', z.object({ exemption: exemptionSchema }), {
      method: 'POST',
      body: input,
    })
  ).exemption;
}

export function deleteExemption(exemptionId: string) {
  return api(`/tax/exemptions/${id(exemptionId)}`, none, { method: 'DELETE' });
}
