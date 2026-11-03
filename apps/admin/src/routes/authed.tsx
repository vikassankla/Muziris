import { createRoute, Outlet, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import {
  CommandPalette,
  ShortcutsDialog,
  Sidebar,
  TopBar,
  useFrameState,
  useShortcuts,
} from '../components/app-frame.js';
import { RouteError } from '../components/problem-view.js';
import { PendingPage } from '../components/states.js';
import { isApiProblem } from '../lib/api.js';
import { listWebsites, signOut, type Website } from '../lib/endpoints.js';
import { forgetSession, loadSession, sessionWasActive } from '../lib/session.js';
import { SessionContext } from '../lib/session-context.js';
import { currentWebsite, WebsiteContext } from '../lib/website.js';
import { rootRoute } from './root.js';

/**
 * The signed-in layout. Its guard asks the API who is signed in on every navigation, so an
 * expired or revoked session sends the admin to sign-in at once, and permission changes show up
 * on the next click.
 */
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_authed',
  beforeLoad: async ({ location, abortController }) => {
    try {
      const session = await loadSession(abortController.signal);
      // The top bar's websites. Without them the screens still work, in India's formats.
      const websites: Website[] = await listWebsites(abortController.signal).catch(
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          return [];
        },
      );
      return { session, websites };
    } catch (error) {
      if (isApiProblem(error) && error.status === 401) {
        throw redirect({
          to: '/sign-in',
          search: {
            redirect: location.href,
            ...(sessionWasActive() ? { reason: 'session_ended' as const } : {}),
          },
        });
      }
      throw error;
    }
  },
  component: AuthedLayout,
  errorComponent: RouteError,
  pendingComponent: PendingPage,
});

function AuthedLayout() {
  const { session, websites } = authedRoute.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const frame = useFrameState();
  const [chosenId, setWebsite] = useState<string | undefined>();
  const website = currentWebsite(websites, chosenId);

  useShortcuts({
    palette: () => {
      frame.setPaletteOpen(true);
    },
    sidebar: () => {
      frame.setCollapsed((c) => !c);
    },
    help: () => {
      frame.setShortcutsOpen(true);
    },
  });

  async function handleSignOut() {
    try {
      await signOut();
    } catch {
      // The session is gone or will expire; leave either way.
    }
    forgetSession();
    await router.invalidate();
    await navigate({ to: '/sign-in', search: {} });
  }

  return (
    <SessionContext.Provider value={session}>
      <WebsiteContext.Provider value={{ website, websites, setWebsite }}>
        <div className="flex min-h-screen bg-background">
          <Sidebar
            session={session}
            collapsed={frame.collapsed}
            onToggle={() => {
              frame.setCollapsed((c) => !c);
            }}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar
              session={session}
              website={website}
              websites={websites}
              onWebsite={setWebsite}
              onOpenPalette={() => {
                frame.setPaletteOpen(true);
              }}
              onOpenShortcuts={() => {
                frame.setShortcutsOpen(true);
              }}
              onSignOut={() => void handleSignOut()}
            />
            <main className="flex-1">
              <Outlet />
            </main>
          </div>
        </div>
        <CommandPalette
          session={session}
          open={frame.paletteOpen}
          onOpenChange={frame.setPaletteOpen}
        />
        <ShortcutsDialog open={frame.shortcutsOpen} onOpenChange={frame.setShortcutsOpen} />
      </WebsiteContext.Provider>
    </SessionContext.Provider>
  );
}
