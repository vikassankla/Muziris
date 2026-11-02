import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The first render in a test file loads the whole router and can take more than a second on a
// busy CI runner; find* queries wait up to 5 s instead of the default 1 s.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.classList.remove('dark');
});

// jsdom does not implement scrolling; the router scrolls to the top after each navigation.
window.scrollTo = () => undefined;

// Radix UI needs a few browser APIs that jsdom leaves out.
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
});
Object.assign(globalThis, {
  ResizeObserver: class {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  },
});
