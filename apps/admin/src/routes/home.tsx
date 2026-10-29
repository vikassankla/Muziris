import { createRoute, Link } from '@tanstack/react-router';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { visibleSections } from '../lib/nav.js';
import { useSession } from '../lib/session-context.js';
import { authedRoute } from './authed.js';

export const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: HomePage,
});

const SHORTCUT_META: Record<string, string> = {
  '/customers': 'Companies that buy from you',
  '/customer-groups': 'Shared settings for customers',
  '/products': 'Everything you sell',
  '/categories': 'The category tree',
  '/product-units': 'Units and their precision',
  '/admin-roles': 'What admin users may do',
  '/buyer-roles': 'What buyer users may do',
};

function greeting(date: Date): string {
  const hour = date.getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * Home: shortcuts to the sections this admin may open. The dashboard figures on the Main
 * board (orders, RFQs, quotes, prices) wait for those APIs.
 */
function HomePage() {
  const session = useSession();
  const sections = visibleSections(session);
  const firstName = session.user.displayName.split(/\s+/)[0] ?? session.user.displayName;
  return (
    <Page>
      <Breadcrumbs crumbs={[]} />
      <PageHeader
        title={`${greeting(new Date())}, ${firstName}`}
        description="Where to start today."
      />
      {sections.length === 0 ? (
        <p className="m-0 text-muted-foreground">
          Your admin roles do not include any of these screens yet. Ask an administrator for access.
        </p>
      ) : (
        <section
          aria-label="Shortcuts"
          className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5"
        >
          {sections.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3 hover:bg-muted"
            >
              <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-foreground">
                <item.icon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex flex-col">
                <span className="font-semibold">{item.label}</span>
                <span className="text-xs text-muted-foreground">{SHORTCUT_META[item.to]}</span>
              </span>
            </Link>
          ))}
        </section>
      )}
    </Page>
  );
}
