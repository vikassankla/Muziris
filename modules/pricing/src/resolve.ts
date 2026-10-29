import { compareDecimals, type CurrencyCode, type Decimal, type Money } from '@muziris/money';
import type { AssignmentTarget } from './assignments.js';
import { isPriceListActive, type PriceList } from './price-lists.js';

// The fallback rule of ADR 0011, written once in plain code. The admin preview uses it to explain
// a price, and the known-answer tests run the same tables through it and through the
// combined price build, so the SQL and this description cannot drift apart unnoticed.

/** One price list in a customer's chain, with its tiers for one product and product unit. */
export interface ChainEntry {
  target: AssignmentTarget;
  targetId: string;
  priority: number;
  priceList: Pick<PriceList, 'id' | 'name' | 'currency' | 'activeFrom' | 'activeUntil'>;
  tiers: readonly { minQuantity: Decimal; amount: Money }[];
}

/**
 * What one step of the chain did: `used` gave the price; `skipped` was reached but had no tier
 * for the quantity; `inactive` was outside its active dates or in another currency; and
 * `not_reached` came after the price was found, with the tier it would have given, if any.
 */
export type ChainStepStatus = 'used' | 'skipped' | 'inactive' | 'not_reached';

export interface ChainStep {
  entry: ChainEntry;
  status: ChainStepStatus;
  tier: { minQuantity: Decimal; amount: Money } | null;
}

export interface Resolution {
  /** The winning tier and where it came from, or null when no price list has a price. */
  price: { unitPrice: Money; minQuantity: Decimal; priceListId: string } | null;
  steps: ChainStep[];
}

/** The tier with the largest minimum quantity at most `quantity`, if any. */
function applicableTier(
  tiers: ChainEntry['tiers'],
  quantity: Decimal,
): ChainEntry['tiers'][number] | null {
  let best: ChainEntry['tiers'][number] | null = null;
  for (const tier of tiers) {
    if (compareDecimals(tier.minQuantity, quantity) > 0) continue;
    if (best === null || compareDecimals(tier.minQuantity, best.minQuantity) > 0) best = tier;
  }
  return best;
}

/**
 * Walks the chain in order and takes the first active price list in the currency with a tier
 * whose minimum quantity is at most the quantity. The unit price is the stored amount, unrounded.
 */
export function resolvePrice(
  chain: readonly ChainEntry[],
  request: { currency: CurrencyCode; quantity: Decimal; now: Date },
): Resolution {
  let price: Resolution['price'] = null;
  const steps = chain.map((entry): ChainStep => {
    if (
      entry.priceList.currency !== request.currency ||
      !isPriceListActive(entry.priceList, request.now)
    ) {
      return { entry, status: 'inactive', tier: null };
    }
    const tier = applicableTier(entry.tiers, request.quantity);
    if (price !== null) return { entry, status: 'not_reached', tier };
    if (tier === null) return { entry, status: 'skipped', tier: null };
    price = {
      unitPrice: tier.amount,
      minQuantity: tier.minQuantity,
      priceListId: entry.priceList.id,
    };
    return { entry, status: 'used', tier };
  });
  return { price, steps };
}
