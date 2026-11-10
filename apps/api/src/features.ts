import type { Database } from '@muziris/db';
import {
  defineSetting,
  loadStoredValues,
  resolveSetting,
  type ScopeContext,
  type SettingDefinition,
} from '@muziris/platform';
import { z } from 'zod';

// Feature toggles (ADR 0031): boolean settings, resolved customer, customer group, website,
// organization, global, like every setting (ADR 0003). All default to on. The storefront API
// enforces them; the storefront app only hides what is off.

const ALL_SCOPES = ['customer', 'customer_group', 'website', 'organization', 'global'] as const;

const toggle = (key: string, description: string) =>
  defineSetting<boolean>({
    key,
    description,
    schema: z.boolean(),
    defaultValue: true,
    allowedScopes: [...ALL_SCOPES],
  });

export const FEATURE_QUICK_ORDER = toggle(
  'features.quick_order',
  'Buyers can order by SKU on the quick order page',
);
export const FEATURE_QUICK_ORDER_CSV = toggle(
  'features.quick_order_csv',
  'Buyers can upload a CSV file on the quick order page; pasting stays',
);
export const FEATURE_SHOPPING_LISTS = toggle(
  'features.shopping_lists',
  'Buyers can keep shopping lists and check out from them',
);

export interface Features {
  quickOrder: boolean;
  quickOrderCsv: boolean;
  shoppingLists: boolean;
}

export type Feature = keyof Features;

const DEFINITIONS: Record<Feature, SettingDefinition<boolean>> = {
  quickOrder: FEATURE_QUICK_ORDER,
  quickOrderCsv: FEATURE_QUICK_ORDER_CSV,
  shoppingLists: FEATURE_SHOPPING_LISTS,
};

/** What a buyer is told when they reach a feature that is off. */
export const FEATURE_OFF_MESSAGES: Record<Feature, string> = {
  quickOrder: "Quick order isn't available on your account",
  quickOrderCsv: "CSV upload isn't available on your account",
  shoppingLists: "Shopping lists aren't available on your account",
};

/** Every toggle for one scope chain, read in one query. */
export async function resolveFeatures(db: Database, context: ScopeContext): Promise<Features> {
  const definitions = Object.values(DEFINITIONS);
  const stored = await loadStoredValues(
    db,
    definitions.map((d) => d.key),
    context,
  );
  const value = (feature: Feature) => {
    const definition = DEFINITIONS[feature];
    return resolveSetting(
      definition,
      stored.filter((s) => s.key === definition.key),
      context,
    ).value;
  };
  return {
    quickOrder: value('quickOrder'),
    quickOrderCsv: value('quickOrderCsv'),
    shoppingLists: value('shoppingLists'),
  };
}
