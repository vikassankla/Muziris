/**
 * Where to go after sign-in. Only paths inside this app are accepted, so a crafted sign-in
 * link cannot send the admin to another site.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  if (value.startsWith('/sign-in')) return undefined;
  return value;
}

/** Reads an optional `after` cursor from the search string. */
export function afterSearch(search: Record<string, unknown>): { after?: string } {
  const after = search['after'];
  return typeof after === 'string' && after.length > 0 && after.length <= 100 ? { after } : {};
}
