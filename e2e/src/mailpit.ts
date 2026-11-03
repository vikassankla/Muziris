// Reads the emails the API sent, from Mailpit's HTTP API (https://mailpit.axllent.org/docs/api-v1/).

import { expect } from '@playwright/test';
import { MAILPIT_URL } from './env.js';

interface MessageSummary {
  ID: string;
  Subject: string;
}

async function search(to: string): Promise<MessageSummary[]> {
  const query = encodeURIComponent(`to:"${to}"`);
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
  const body = (await response.json()) as { messages: MessageSummary[] };
  return body.messages;
}

/**
 * Waits for an email to this address whose subject matches, and returns its text. The API's
 * sender runs every 10 seconds (ADR 0020), so this waits up to 30.
 */
export async function waitForEmail(
  to: string,
  subject: RegExp,
): Promise<{ subject: string; text: string }> {
  let found: MessageSummary | undefined;
  await expect
    .poll(
      async () => {
        found = (await search(to)).find((m) => subject.test(m.Subject));
        return found !== undefined;
      },
      { message: `an email to ${to} matching ${subject}`, timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`No email to ${to}`);
  const response = await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
  if (!response.ok) throw new Error(`Mailpit message failed: ${response.status}`);
  const message = (await response.json()) as { Subject: string; Text: string };
  return { subject: message.Subject, text: message.Text };
}

/** The first link in an email's text that starts with this address. */
export function linkIn(text: string, startingWith: string): string {
  const link = text.split(/\s+/).find((word) => word.startsWith(startingWith));
  if (link === undefined) throw new Error(`No link to ${startingWith} in the email`);
  return link;
}
