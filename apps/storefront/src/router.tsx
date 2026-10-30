import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { PendingList, RouteError } from './components/states.js';
import { authedRoute } from './routes/authed.js';
import { categoryRoute, homeRoute } from './routes/catalog.js';
import { productRoute } from './routes/product.js';
import { rootRoute } from './routes/root.js';
import { searchRoute } from './routes/search.js';
import { signInRoute } from './routes/sign-in.js';

const routeTree = rootRoute.addChildren([
  signInRoute,
  authedRoute.addChildren([homeRoute, categoryRoute, productRoute, searchRoute]),
]);

/** The storefront router. Tests pass a memory history. */
export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    ...(options.history ? { history: options.history } : {}),
    defaultPreload: false,
    // Every navigation asks again, so prices and what the buyer may see are fresh.
    defaultStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultPendingComponent: PendingList,
    defaultPendingMs: 300,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
