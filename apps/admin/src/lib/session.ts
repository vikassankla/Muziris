import { getMe, getMyPermissions, type AdminUser } from './endpoints.js';

/**
 * Admin permissions. They mirror ADMIN_PERMISSIONS in @muziris/access; the API stays the real
 * check, so a stale entry here only hides or shows a link or a button.
 */
export const ADMIN_PERMISSION_KEYS = [
  'admin_role.view',
  'admin_role.manage',
  'admin_role.assign',
  'admin_user.view',
  'admin_user.manage',
  'buyer_role.view',
  'buyer_role.manage',
  'website.view',
  'website.manage',
  'setting.view',
  'setting.manage',
  'customer.view',
  'customer.manage',
  'product.view',
  'product.manage',
  'price_list.view',
  'price_list.manage',
  'visibility.view',
  'visibility.manage',
  'order.view',
  'order.manage',
  'tax.view',
  'tax.manage',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSION_KEYS)[number];

/** Who is signed in and what they may do. Held in memory only, never in browser storage. */
export interface Session {
  user: AdminUser;
  permissions: ReadonlySet<string>;
}

let hadSession = false;

/**
 * True once this tab has seen a live session, so a later 401 means the session ended (idle or
 * absolute timeout, sign-out elsewhere) rather than a first visit.
 */
export function sessionWasActive(): boolean {
  return hadSession;
}

export function forgetSession(): void {
  hadSession = false;
}

/** Reads the session from the API. Rejects with a 401 ApiProblem when nobody is signed in. */
export async function loadSession(signal?: AbortSignal): Promise<Session> {
  // Ask for the user first: when the session is gone, that 401 is the answer, not access/me's.
  const user = await getMe(signal);
  const permissions = await getMyPermissions(signal);
  hadSession = true;
  return { user, permissions: new Set(permissions) };
}

export function can(session: Session, permission: AdminPermission): boolean {
  return session.permissions.has(permission);
}
