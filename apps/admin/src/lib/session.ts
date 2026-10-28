import { getMe, getMyPermissions, type AdminUser } from './endpoints.js';

/**
 * Admin permissions the app knows about. They mirror ADMIN_PERMISSIONS in @muziris/access;
 * the API stays the real check, so a stale entry here only hides or shows a link.
 */
export type AdminPermission =
  | 'admin_role.view'
  | 'admin_role.manage'
  | 'admin_role.assign'
  | 'buyer_role.view'
  | 'buyer_role.manage'
  | 'customer.view'
  | 'customer.manage'
  | 'product.view'
  | 'product.manage';

/** Who is signed in and what they may do. Held in memory only, never in browser storage. */
export interface Session {
  user: AdminUser;
  permissions: ReadonlySet<string>;
}

/** Reads the session from the API. Rejects with a 401 ApiProblem when nobody is signed in. */
export async function loadSession(signal?: AbortSignal): Promise<Session> {
  // Ask for the user first: when the session is gone, that 401 is the answer, not access/me's.
  const user = await getMe(signal);
  const permissions = await getMyPermissions(signal);
  return { user, permissions: new Set(permissions) };
}

export function can(session: Session, permission: AdminPermission): boolean {
  return session.permissions.has(permission);
}
