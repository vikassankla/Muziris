import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
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
