import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { RouteError } from '../components/problem-view.js';
import { Toaster } from '../components/ui/sonner.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { ThemeProvider, useTheme } from '../lib/theme.js';

function NotFound() {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="m-0 text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-meta text-muted-foreground">
        <Link to="/" className="text-primary underline underline-offset-2">
          Go to Home
        </Link>
      </p>
    </div>
  );
}

function ThemedToaster() {
  return <Toaster theme={useTheme().resolved} />;
}

function Root() {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <Outlet />
        <ThemedToaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

export const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});
