// The storefront's content security policy, written into index.html by the production build
// (vite.config.ts). The dev server runs without it, since React's refresh needs an inline script.
//
// Scripts come from this origin and the two payment gateways only (ADR 0019): Stripe's Payment
// Element and Razorpay Checkout must load from the gateways' own hosts, and their payment forms
// run in frames from those hosts, so card and bank details never touch this page.

const POLICY: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://js.stripe.com', 'https://checkout.razorpay.com'],
  'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://api.razorpay.com'],
  'connect-src': ["'self'", 'https://api.stripe.com', 'https://lumberjack.razorpay.com'],
  'img-src': ["'self'", 'data:', 'https://*.stripe.com', 'https://cdn.razorpay.com'],
  // Tailwind's output is a stylesheet, but both gateways set inline styles on what they add.
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

export const CONTENT_SECURITY_POLICY = Object.entries(POLICY)
  .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
  .join('; ');
