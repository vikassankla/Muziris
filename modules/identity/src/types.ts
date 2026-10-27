export type Realm = 'admin' | 'buyer';

/** What the rest of the system may know about a signed-in person. Never includes the hash. */
export interface AuthenticatedUser {
  id: string;
  realm: Realm;
  email: string;
  displayName: string;
}
