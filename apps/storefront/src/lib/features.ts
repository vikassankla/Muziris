import type { ShellData } from './session.js';

// Feature toggles (ADR 0031). The API refuses a feature that is off; the app hides its links and
// buttons, and a page reached by its address shows FEATURE_OFF_TITLE instead of failing.

export type Feature = keyof ShellData['features'];

export const FEATURE_OFF_TITLE = "This isn't available on your account";

/** Thrown from a route's beforeLoad when its feature is off; RouteError shows it. */
export class FeatureUnavailableError extends Error {
  readonly feature: Feature;

  constructor(feature: Feature) {
    super(FEATURE_OFF_TITLE);
    this.name = 'FeatureUnavailableError';
    this.feature = feature;
  }
}

/** Stops a route whose feature is off for this buyer before its loader asks the API. */
export function requireFeature(shell: ShellData, feature: Feature): void {
  if (!shell.features[feature]) throw new FeatureUnavailableError(feature);
}
