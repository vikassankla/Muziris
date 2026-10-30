import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { forgetShell } from '../lib/session.js';

afterEach(() => {
  forgetShell({ signedOut: true });
});

// The operations tests run in Node; everything else runs in jsdom.
if (typeof window !== 'undefined') {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  // jsdom does not implement scrolling; the router scrolls to the top after each navigation.
  window.scrollTo = () => undefined;
}
