import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { RouteError } from './components/problem-view.js';
import { PendingPage } from './components/states.js';
import { adminRolesRoute } from './routes/admin-roles.js';
import { authedRoute } from './routes/authed.js';
import { buyerRoleDetailRoute, buyerRolesRoute } from './routes/buyer-roles.js';
import { categoriesRoute, productsRoute } from './routes/catalog.js';
import { customerDetailRoute } from './routes/customer-detail.js';
import { customerGroupsRoute } from './routes/customer-groups.js';
import { customersRoute } from './routes/customers.js';
import { homeRoute } from './routes/home.js';
import { productUnitsRoute } from './routes/product-units.js';
import { rootRoute } from './routes/root.js';
import { signInRoute } from './routes/sign-in.js';

const routeTree = rootRoute.addChildren([
  signInRoute,
  authedRoute.addChildren([
    homeRoute,
    customersRoute,
    customerDetailRoute,
    customerGroupsRoute,
    productsRoute,
    categoriesRoute,
    productUnitsRoute,
    adminRolesRoute,
    buyerRolesRoute,
    buyerRoleDetailRoute,
  ]),
]);

/** The admin router. Tests pass a memory history. */
export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    ...(options.history ? { history: options.history } : {}),
    defaultPreload: false,
    // Every navigation reloads its data, so the API's answer (and its permission check) is fresh.
    defaultStaleTime: 0,
    // A screen's error and loading state render inside the signed-in layout.
    defaultErrorComponent: RouteError,
    defaultPendingComponent: PendingPage,
    defaultPendingMs: 300,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
