import { createContext, useContext } from 'react';
import type { DisplayContext } from './format.js';

/**
 * The website the admin is working on. There is no websites API yet, so the top bar offers
 * these two placeholders, which only decide how numbers and dates are shown.
 */
export interface WebsiteChoice extends DisplayContext {
  id: string;
  name: string;
  meta: string;
}

export const PLACEHOLDER_WEBSITES: readonly WebsiteChoice[] = [
  {
    id: 'placeholder-in',
    name: 'India',
    meta: 'INR · IST',
    locale: 'en-IN',
    currency: 'INR',
    timeZone: 'Asia/Kolkata',
  },
  {
    id: 'placeholder-us',
    name: 'United States',
    meta: 'USD · CT',
    locale: 'en-US',
    currency: 'USD',
    timeZone: 'America/Chicago',
  },
];

// The array is a non-empty literal; the fallback only satisfies noUncheckedIndexedAccess.
export const DEFAULT_WEBSITE: WebsiteChoice = PLACEHOLDER_WEBSITES[0] ?? {
  id: 'placeholder-in',
  name: 'India',
  meta: 'INR · IST',
  locale: 'en-IN',
  currency: 'INR',
  timeZone: 'Asia/Kolkata',
};

export const WebsiteContext = createContext<{
  website: WebsiteChoice;
  setWebsite: (website: WebsiteChoice) => void;
}>({ website: DEFAULT_WEBSITE, setWebsite: () => undefined });

export function useWebsite(): WebsiteChoice {
  return useContext(WebsiteContext).website;
}
