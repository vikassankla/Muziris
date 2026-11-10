import { availableMethods, METHOD_CURRENCIES, type PaymentMethod } from '@muziris/orders';
import { PAYMENT_METHOD_LABELS } from './settings.js';

// Checkout drops a listed payment method it cannot use (ADR 0019): a gateway without keys, or
// one that does not take the website's currency. With none left it refuses every order. These
// warnings tell the admin so on the Settings page, before a buyer finds out.

export interface WebsiteCurrency {
  name: string;
  defaultCurrency: string;
}

/** Plain-language warnings for a payment methods value, for the websites it reaches. */
export function paymentMethodWarnings(
  listed: readonly PaymentMethod[],
  configured: ReadonlySet<PaymentMethod>,
  websites: readonly WebsiteCurrency[],
): string[] {
  if (listed.length === 0) {
    return ['No payment method is chosen, so checkout refuses every order.'];
  }
  const refusing = websites
    .filter((w) => availableMethods(listed, configured, w.defaultCurrency).length === 0)
    .map(
      (w) => `Checkout refuses every order on ${w.name}: none of these methods can be used there.`,
    );
  const unique = listed.filter((m, i) => listed.indexOf(m) === i);
  const withoutKeys = unique
    .filter((m) => m !== 'terms' && !configured.has(m))
    .map((m) => `${PAYMENT_METHOD_LABELS[m]} is not offered: its keys are not set on the server.`);
  const wrongCurrency = unique.flatMap((m) => {
    if (m === 'terms' || !configured.has(m)) return [];
    const currency = METHOD_CURRENCIES[m];
    return websites
      .filter((w) => w.defaultCurrency !== currency)
      .map(
        (w) =>
          `${PAYMENT_METHOD_LABELS[m]} is not offered on ${w.name}: it takes ${currency} only.`,
      );
  });
  return [...refusing, ...withoutKeys, ...wrongCurrency];
}
