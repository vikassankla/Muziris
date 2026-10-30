import { redirect } from '@tanstack/react-router';
import { isApiProblem } from './api.js';
import { forgetShell, sessionWasActive } from './session.js';

/**
 * Turns a 401 from any storefront call into a trip to sign-in that comes back here afterwards,
 * saying the session ended when this tab had one. Anything else is rethrown.
 */
export function signInOn401(error: unknown, href: string): never {
  if (isApiProblem(error) && error.status === 401) {
    const ended = sessionWasActive();
    forgetShell({ signedOut: true });
    throw redirect({
      to: '/sign-in',
      search: { redirect: href, ...(ended ? { reason: 'session_ended' as const } : {}) },
    });
  }
  throw error;
}
