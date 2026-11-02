import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { PendingList, RouteError } from './components/states.js';
import { acceptInvitationRoute } from './routes/accept-invitation.js';
import { authedRoute } from './routes/authed.js';
import { categoryRoute, homeRoute } from './routes/catalog.js';
import { checkoutRoute } from './routes/checkout.js';
import { listRoute, listsRoute } from './routes/lists.js';
import { orderRoute, ordersRoute } from './routes/orders.js';
import { productRoute } from './routes/product.js';
import { quickOrderRoute } from './routes/quick-order.js';
import { rootRoute } from './routes/root.js';
import { searchRoute } from './routes/search.js';
import { signInRoute } from './routes/sign-in.js';

const routeTree = rootRoute.addChildren([
  signInRoute,
  acceptInvitationRoute,
  authedRoute.addChildren([
    homeRoute,
    categoryRoute,
    productRoute,
    searchRoute,
    ordersRoute,
    orderRoute,
    listsRoute,
    listRoute,
    quickOrderRoute,
    checkoutRoute,
  ]),
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
