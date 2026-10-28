import {
  createRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useState } from 'react';
import { RouteError } from '../components/problem-view.js';
import { Button } from '../components/ui/button.js';
import { isApiProblem } from '../lib/api.js';
import { signOut } from '../lib/endpoints.js';
import { can, loadSession, type AdminPermission, type Session } from '../lib/session.js';
import { SessionContext } from '../lib/session-context.js';
import { rootRoute } from './root.js';

export interface NavItem {
  to: '/customers' | '/buyer-roles' | '/products' | '/categories' | '/admin-roles';
  label: string;
  permission: AdminPermission;
}

/** Every section of the admin and the permission that reveals it. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/customers', label: 'Customers', permission: 'customer.view' },
  { to: '/buyer-roles', label: 'Buyer roles', permission: 'buyer_role.view' },
  { to: '/products', label: 'Products', permission: 'product.view' },
  { to: '/categories', label: 'Categories', permission: 'product.view' },
  { to: '/admin-roles', label: 'Admin roles', permission: 'admin_role.view' },
];

export function visibleNavItems(session: Session): NavItem[] {
  return NAV_ITEMS.filter((item) => can(session, item.permission));
}

/**
 * The signed-in layout. Its guard asks the API who is signed in on every navigation, so an
 * expired or revoked session sends the admin to sign-in at once, and permission changes show up
 * on the next click.
 */
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_authed',
  beforeLoad: async ({ location, abortController }) => {
    try {
      return { session: await loadSession(abortController.signal) };
    } catch (error) {
      if (isApiProblem(error) && error.status === 401) {
        throw redirect({ to: '/sign-in', search: { redirect: location.href } });
      }
      throw error;
    }
  },
  component: AuthedLayout,
  errorComponent: RouteError,
});

function AuthedLayout() {
  const { session } = authedRoute.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // The session is gone or will expire; leave either way.
    }
    await router.invalidate();
    await navigate({ to: '/sign-in', search: {} });
  }

  return (
    <SessionContext.Provider value={session}>
      <div className="flex min-h-screen">
        <aside className="w-56 shrink-0 border-r bg-muted/40 p-4">
          <Link to="/" className="mb-6 block text-lg font-semibold">
            Muziris admin
          </Link>
          <nav aria-label="Main">
            <ul className="flex flex-col gap-1">
              {visibleNavItems(session).map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="block rounded-md px-3 py-2 text-sm hover:bg-accent"
                    activeProps={{ className: 'bg-accent font-medium' }}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-end gap-4 border-b px-6 py-3 text-sm">
            <span className="text-muted-foreground">
              {session.user.displayName} ({session.user.email})
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              Sign out
            </Button>
          </header>
          <main className="flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
