// Quick order hands its lines to the checkout page in memory, for this tab only (ADR 0018):
// no business data goes into browser storage, so a reload sends the buyer back to quick order.

export interface CheckoutLine {
  productId: string;
  unitCode: string;
  quantity: string;
}

let handedOver: readonly CheckoutLine[] | undefined;

export function handToCheckout(lines: readonly CheckoutLine[]): void {
  handedOver = lines;
}

/** The lines quick order handed over, if this tab has any. */
export function quickOrderLines(): readonly CheckoutLine[] | undefined {
  return handedOver;
}

/** Forgets the lines once their order is placed. */
export function forgetQuickOrder(): void {
  handedOver = undefined;
}
