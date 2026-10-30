/**
 * Where to go after sign-in. Only paths inside this app are accepted, so a crafted sign-in
 * link cannot send the buyer to another site.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  if (value.startsWith('/sign-in')) return undefined;
  return value;
}
