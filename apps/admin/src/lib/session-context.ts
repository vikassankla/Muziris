import { createContext, useContext } from 'react';
import type { Session } from './session.js';

export const SessionContext = createContext<Session | undefined>(undefined);

/** The signed-in admin. Only for components under the signed-in layout. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession is only available inside the signed-in layout');
  return session;
}
