import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { RouteError } from '../components/states.js';

function NotFound() {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="m-0 text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-meta text-muted-foreground">
        <Link to="/" className="text-primary underline underline-offset-2">
          Go to all products
        </Link>
      </p>
    </div>
  );
}

/** Light or dark, following the buyer's system setting (the admin app's tokens, ADR 0015). */
function useSystemTheme() {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.classList.toggle('dark', query.matches);
    };
    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  }, []);
}

function Root() {
  useSystemTheme();
  return <Outlet />;
}

export const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});
