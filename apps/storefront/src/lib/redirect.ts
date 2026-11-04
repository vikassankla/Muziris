/** Any origin will do: a value is read against it only to see where a browser would go. */
const BASE = 'https://muziris.invalid';

/** Tabs, line breaks and other control characters, which browsers drop from URLs. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Where to go after sign-in. Only paths inside this app are accepted, so a crafted sign-in
 * link cannot send the buyer to another site. The value is read as a browser reads a URL, which
 * drops tabs and line breaks, so "/<tab>/evil.example" is refused like "//evil.example".
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.includes('\\') || hasControlCharacter(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE || url.pathname.startsWith('//')) return undefined;
  if (url.pathname.startsWith('/sign-in')) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}
