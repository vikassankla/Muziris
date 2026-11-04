// The admin app's content security policy, written into index.html by the production build
// (vite.config.ts). The dev server runs without it, since React's refresh needs an inline script.
//
// Everything comes from this origin: the fonts are bundled, the API is on the same origin, and
// the two-factor QR code is drawn as inline SVG. Nothing else may run or load, so a value that
// slipped past React's escaping still could not run a script or send data elsewhere.
// frame-ancestors cannot be set in a meta tag; the web server sends it (docker/nginx.conf).

const POLICY: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'connect-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  // Radix and the toasts add style elements and attributes at runtime.
  'style-src': ["'self'", "'unsafe-inline'"],
  // The build inlines the smallest font files as data: URLs.
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

export const CONTENT_SECURITY_POLICY = Object.entries(POLICY)
  .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
  .join('; ');
