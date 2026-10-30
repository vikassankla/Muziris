import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { forgetShell } from '../lib/session.js';

// The first render in a test file loads the whole router and can take more than a second on a
// busy CI runner; find* queries wait up to 5 s instead of the default 1 s.
configure({ asyncUtilTimeout: 5000 });

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
