import { createRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '../components/page-header.js';
import { Card, CardHeader, CardTitle } from '../components/ui/card.js';
import { useSession } from '../lib/session-context.js';
import { authedRoute, visibleNavItems } from './authed.js';

export const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: HomePage,
});

function HomePage() {
  const session = useSession();
  const items = visibleNavItems(session);
  return (
    <div>
      <PageHeader title={`Welcome, ${session.user.displayName}`} />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Your admin roles do not include any of these screens yet. Ask an administrator for access.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Link key={item.to} to={item.to}>
              <Card className="transition-colors hover:bg-accent">
                <CardHeader>
                  <CardTitle>{item.label}</CardTitle>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
