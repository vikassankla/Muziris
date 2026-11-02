// The payment gateways' own browser scripts (ADR 0019). They load from the gateways' hosts, as
// both require, and only when the buyer pays. Card, UPI and bank details go into the gateway's
// form, in the gateway's frame, and never pass through this app or the Muziris API.

export const STRIPE_JS = 'https://js.stripe.com/v3/';
export const RAZORPAY_JS = 'https://checkout.razorpay.com/v1/checkout.js';

/** The parts of Stripe.js the payment step uses. */
export interface StripeJs {
  elements(options: { clientSecret: string }): {
    create(type: 'payment'): { mount(element: HTMLElement): void; destroy(): void };
  };
  confirmPayment(options: {
    elements: ReturnType<StripeJs['elements']>;
    confirmParams: { return_url: string };
  }): Promise<{ error?: { message?: string } }>;
}

/** The parts of Razorpay Checkout the payment step uses. */
export interface RazorpayCheckout {
  open(): void;
}

export interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: () => void;
  modal: { ondismiss: () => void };
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeJs;
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}

const loading = new Map<string, Promise<void>>();

/** Adds a gateway's script to the page once; later calls wait for the same load. */
export function loadScript(src: string): Promise<void> {
  const known = loading.get(src);
  if (known) return known;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      loading.delete(src);
      script.remove();
      reject(new Error(`Could not load ${src}`));
    };
    document.head.append(script);
  });
  loading.set(src, promise);
  return promise;
}

export async function loadStripe(publishableKey: string): Promise<StripeJs> {
  await loadScript(STRIPE_JS);
  if (!window.Stripe) throw new Error('Stripe.js did not load');
  return window.Stripe(publishableKey);
}

export async function openRazorpay(options: RazorpayOptions): Promise<void> {
  await loadScript(RAZORPAY_JS);
  if (!window.Razorpay) throw new Error('Razorpay Checkout did not load');
  new window.Razorpay(options).open();
}
