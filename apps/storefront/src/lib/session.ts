import { Shell, type ShellResult } from '../operations/generated.js';
import { runOperation } from './api.js';

/** The signed-in buyer, their customer, the website and its categories (Shell.graphql). */
export type ShellData = ShellResult;

let cached: Promise<ShellData> | undefined;
let hadSession = false;

/**
 * True once this tab has seen a live session, so a later 401 means the session ended (idle or
 * absolute timeout, sign-out elsewhere) rather than a first visit.
 */
export function sessionWasActive(): boolean {
  return hadSession;
}

/**
 * Loads the shell once per session and keeps it in memory, never in browser storage. A failed
 * load is not kept, so the next navigation asks again.
 */
export function loadShell(signal?: AbortSignal): Promise<ShellData> {
  cached ??= runOperation(Shell, {}, { signal }).then(
    (data) => {
      hadSession = true;
      return data;
    },
    (error: unknown) => {
      cached = undefined;
      throw error;
    },
  );
  return cached;
}

/** Forgets the shell, after sign-in, sign-out or a 401. */
export function forgetShell(options: { signedOut?: boolean } = {}): void {
  cached = undefined;
  if (options.signedOut) hadSession = false;
}
