import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom does not implement scrolling; the router scrolls to the top after each navigation.
window.scrollTo = () => undefined;
