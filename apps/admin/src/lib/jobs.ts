import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import type { JobStatus } from './endpoints.js';

/** How often a screen with a queued or running build looks again. */
export const BUILD_POLL_MS = 3_000;

/**
 * Reloads the screen's data every few seconds while a build job is queued or running, so its
 * banner moves from "Queued" to "Building" to gone without a manual refresh (ADR 0025).
 */
export function useRefreshWhileBuilding(job: JobStatus | undefined): void {
  const router = useRouter();
  const active = job === 'queued' || job === 'running';
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      void router.invalidate();
    }, BUILD_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active, router]);
}

/** What a queued or running build tells an admin, or undefined when none is. */
export function buildProgress(job: JobStatus, what: string): string | undefined {
  if (job === 'running') return `The ${what} build is running.`;
  if (job === 'queued') return `A ${what} build is queued and starts within seconds.`;
  return undefined;
}
