import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { PREF_KEYS, readPref, writePref } from './prefs.js';

export type ThemeChoice = 'system' | 'light' | 'dark';

interface ThemeState {
  choice: ThemeChoice;
  resolved: 'light' | 'dark';
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeState>({
  choice: 'system',
  resolved: 'light',
  setChoice: () => undefined,
});

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/**
 * Light or dark, following prefers-color-scheme unless the admin picks one in the user menu.
 * The choice is remembered in localStorage (see prefs.ts), so it survives reloads and new tabs.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setStoredChoice] = useState<ThemeChoice>(() => {
    const stored = readPref(PREF_KEYS.theme);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });
  const setChoice = (next: ThemeChoice) => {
    setStoredChoice(next);
    writePref(PREF_KEYS.theme, next);
  };
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
