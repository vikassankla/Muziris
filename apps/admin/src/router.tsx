import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { RouteError } from './components/problem-view.js';
import { adminRolesRoute } from './routes/admin-roles.js';
import { authedRoute } from './routes/authed.js';
import { buyerRoleDetailRoute, buyerRolesRoute } from './routes/buyer-roles.js';
import { categoriesRoute, productsRoute } from './routes/catalog.js';
import { customerDetailRoute, customersRoute } from './routes/customers.js';
import { homeRoute } from './routes/home.js';
import { rootRoute } from './routes/root.js';
import { signInRoute } from './routes/sign-in.js';

const routeTree = rootRoute.addChildren([
  signInRoute,
  authedRoute.addChildren([
    homeRoute,
    customersRoute,
    customerDetailRoute,
    buyerRolesRoute,
    buyerRoleDetailRoute,
    productsRoute,
    categoriesRoute,
    adminRolesRoute,
  ]),
]);

/** The admin router. Tests pass a memory history. */
export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    ...(options.history ? { history: options.history } : {}),
    defaultPreload: false,
    // A screen's error renders inside the signed-in layout, so navigation and sign-out stay.
    defaultErrorComponent: RouteError,
    // Every navigation reloads its data, so the API's answer (and its permission check) is fresh.
    defaultStaleTime: 0,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
