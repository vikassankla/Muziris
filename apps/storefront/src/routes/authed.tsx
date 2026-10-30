import {
  createRoute,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { Footer, Header } from '../components/header.js';
import { PendingList, RouteError } from '../components/states.js';
import { signOut } from '../lib/api.js';
import { CategoryTree } from '../lib/categories.js';
import { signInOn401 } from '../lib/guard.js';
import { forgetShell, loadShell } from '../lib/session.js';
import { rootRoute } from './root.js';

/**
 * The signed-in layout. Its guard loads the shell (who is signed in, the website, the
 * categories) once per session; a 401 from it or from any page's loader sends the buyer to
 * sign-in and back.
 */
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_authed',
  beforeLoad: async ({ location, abortController }) => {
    try {
      const shell = await loadShell(abortController.signal);
      return { shell, tree: new CategoryTree(shell.categories) };
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: AuthedLayout,
  errorComponent: RouteError,
  pendingComponent: PendingList,
});

function AuthedLayout() {
  const { shell, tree } = authedRoute.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  // The category a page is about, from its route params, for the category bar.
  const matches = useMatches();
  let categoryId: string | undefined;
  for (const match of matches) {
    const params = match.params as Record<string, string | undefined>;
    categoryId = params['categoryId'] ?? categoryId;
  }
  const productCategory = (
    matches.at(-1)?.loaderData as
      { product?: { category: { id: string } | null } | null } | undefined
  )?.product?.category?.id;
  const current = categoryId ?? productCategory;
  const currentTop = current === undefined ? undefined : tree.path(current)[0]?.id;
  const searchText =
    location.pathname === '/search' ? (location.search as { q?: string }).q : undefined;

  async function handleSignOut() {
    try {
      await signOut();
    } catch {
      // The session is gone or will expire; leave either way.
    }
    forgetShell({ signedOut: true });
    await router.invalidate();
    await navigate({ to: '/sign-in', search: {} });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header
        shell={shell}
        tree={tree}
        currentTop={currentTop}
        {...(searchText === undefined ? {} : { searchText })}
        onSignOut={() => void handleSignOut()}
      />
      <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 py-6 md:px-6">
        <Outlet />
      </main>
      <Footer shell={shell} />
    </div>
  );
}
