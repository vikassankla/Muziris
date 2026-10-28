import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { RouteError } from '../components/problem-view.js';

function NotFound() {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        <Link to="/" className="underline">
          Go to the start page
        </Link>
      </p>
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});
