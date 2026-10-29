// Every permission is declared here, with what it lets a person do. The database stores keys
// only; a stored key missing from these catalogues is ignored, so removing one fails closed.

/** What an admin user may do in the admin. */
export const ADMIN_PERMISSIONS = {
  'admin_role.view': 'See admin roles and their permissions',
  'admin_role.manage': 'Create, edit and delete admin roles',
  'admin_role.assign': 'Give admin roles to admin users and take them away',
  'admin_user.view': 'See admin users',
  'admin_user.manage': 'Create, edit and disable admin users',
  'buyer_role.view': 'See buyer roles and their permissions',
  'buyer_role.manage': 'Create, edit and delete buyer roles',
  'website.view': 'See websites',
  'website.manage': 'Create and edit websites',
  'setting.view': 'See settings and feature toggles',
  'setting.manage': 'Change settings and feature toggles',
  'customer.view': 'See customers, customer groups and buyer users',
  'customer.manage': 'Create and edit customers, customer groups and buyer users',
  'product.view': 'See products and categories',
  'product.manage': 'Create and edit products and categories',
  'price_list.view': 'See price lists',
  'price_list.manage': 'Create and edit price lists',
  'visibility.view': 'See which products and categories buyers may see, and why',
  'visibility.manage': 'Show or hide products and categories for buyers, and run the build',
  'order.view': 'See orders',
  'order.manage': 'Change and cancel orders',
} as const;

export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;

/**
 * What a buyer user may do in the storefront. Each grant carries an access level that bounds
 * which records it reaches; for create actions, which customers it may create them for.
 */
export const BUYER_PERMISSIONS = {
  'order.view': 'See orders',
  'order.place': 'Place orders',
  'shopping_list.view': 'See shopping lists',
  'shopping_list.manage': 'Create, edit and delete shopping lists',
  'rfq.view': 'See RFQs',
  'rfq.create': 'Send RFQs',
  'quote.view': 'See quotes',
  'quote.accept': 'Accept quotes',
  'address.view': 'See addresses',
  'address.manage': 'Create, edit and delete addresses',
  'buyer_user.view': 'See buyer users',
  'buyer_user.manage': 'Invite, edit and disable buyer users',
} as const;

export type BuyerPermission = keyof typeof BUYER_PERMISSIONS;

/**
 * Buyer role access levels, narrowest first (glossary: "Buyer role"). The order matters: a
 * buyer with several roles gets the widest level per permission.
 */
export const ACCESS_LEVELS = [
  'own_records',
  'my_customer',
  'my_customer_and_subsidiaries',
] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function isAdminPermission(key: string): key is AdminPermission {
  return Object.hasOwn(ADMIN_PERMISSIONS, key);
}

export function isBuyerPermission(key: string): key is BuyerPermission {
  return Object.hasOwn(BUYER_PERMISSIONS, key);
}

export const ALL_ADMIN_PERMISSIONS = Object.keys(ADMIN_PERMISSIONS) as AdminPermission[];

/** The wider of two access levels; undefined means no access. */
export function widerAccessLevel(
  a: AccessLevel | undefined,
  b: AccessLevel | undefined,
): AccessLevel | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return ACCESS_LEVELS.indexOf(a) >= ACCESS_LEVELS.indexOf(b) ? a : b;
}
