// UI preferences kept in localStorage. These are the only keys the admin app may store in the
// browser: nothing about the session, the admin user or the business ever goes here (the
// session lives in the API's HttpOnly cookie). Tests check that no other key appears.

export const PREF_KEYS = {
  theme: 'muziris.admin.theme',
  sidebarCollapsed: 'muziris.admin.sidebarCollapsed',
} as const;

type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

/** The stored value, or undefined when there is none or storage is unavailable. */
export function readPref(key: PrefKey): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    // Private windows and blocked site data: fall back to the default.
    return undefined;
  }
}

export function writePref(key: PrefKey, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not saved; the choice still applies for this tab.
  }
}
