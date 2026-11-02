import { createContext, useContext } from 'react';
import type { Website } from './endpoints.js';
import type { DisplayContext } from './format.js';

/**
 * The website the admin is working on, chosen in the top bar (ADR 0021). It decides how money,
 * quantities and dates are shown, and which website the Settings screen starts from. The choice
 * is kept in memory only: browser storage holds UI preferences alone (decided 2026-10-29).
 */
export interface WebsiteChoice extends DisplayContext {
  /** The website's id; empty for the stand-in used before any website exists. */
  id: string;
  name: string;
  meta: string;
}

/** The short name of a time zone today, such as IST or CST. */
function zoneName(timeZone: string, locale: string): string {
  const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

/** How a currency is shown: the pilot's two (the API refuses websites in any other). */
export const CURRENCY_DISPLAY: Record<'INR' | 'USD', Omit<DisplayContext, 'timeZone'>> = {
  INR: { locale: 'en-IN', currency: 'INR' },
  USD: { locale: 'en-US', currency: 'USD' },
};

export function websiteChoice(website: Website): WebsiteChoice {
  const currency = website.defaultCurrency === 'USD' ? 'USD' : 'INR';
  return {
    id: website.id,
    name: website.name,
    meta: `${website.defaultCurrency} · ${zoneName(website.timeZone, website.defaultLocale)}`,
    locale: website.defaultLocale === 'en-US' ? 'en-US' : 'en-IN',
    currency,
    timeZone: website.timeZone,
  };
}

/** Shown before the first website is created: India's formats, as the pilot starts there. */
export const NO_WEBSITE: WebsiteChoice = {
  id: '',
  name: 'No website yet',
  meta: 'INR · IST',
  locale: 'en-IN',
  currency: 'INR',
  timeZone: 'Asia/Kolkata',
};

/** The website to show: the chosen one if it still exists, else the first active one. */
export function currentWebsite(
  websites: readonly Website[],
  chosenId: string | undefined,
): WebsiteChoice {
  const chosen = websites.find((w) => w.id === chosenId);
  const website = chosen ?? websites.find((w) => w.isActive) ?? websites[0];
  return website ? websiteChoice(website) : NO_WEBSITE;
}

export const WebsiteContext = createContext<{
  website: WebsiteChoice;
  websites: readonly Website[];
  setWebsite: (websiteId: string) => void;
}>({ website: NO_WEBSITE, websites: [], setWebsite: () => undefined });

export function useWebsite(): WebsiteChoice {
  return useContext(WebsiteContext).website;
}

export function useWebsites(): readonly Website[] {
  return useContext(WebsiteContext).websites;
}
