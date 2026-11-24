import { createHash, timingSafeEqual } from 'node:crypto';
import { OUTBOX_METADATA_KEY } from './suppression.js';

// Postmark (ADR 0032): the message stream, the headers that tie a bounce to its email, and the
// webhook's basic authentication. The webhook password is a secret from the environment
// (ADR 0019): errors name the variable, never its value, and it is never logged.

export interface PostmarkWebhookCredentials {
  user: string;
  password: string;
}

export interface PostmarkConfig {
  /** The stream every email goes to; Postmark's default transactional stream is outbound. */
  messageStream: string;
  /** Unset: the webhook endpoint answers 404, as if it did not exist. */
  webhook: PostmarkWebhookCredentials | undefined;
}

export const POSTMARK_ENV_NAMES = [
  'POSTMARK_MESSAGE_STREAM',
  'POSTMARK_WEBHOOK_USER',
  'POSTMARK_WEBHOOK_PASSWORD',
] as const;

export const POSTMARK_SMTP_HOST = 'smtp.postmarkapp.com';

const MIN_PASSWORD_LENGTH = 24;

function read(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name]?.trim();
  return value === '' ? undefined : value;
}

/** Throws with every problem at once, naming variables only. */
export function postmarkConfigFromEnv(source: Record<string, string | undefined>): PostmarkConfig {
  const problems: string[] = [];
  const stream = read(source, 'POSTMARK_MESSAGE_STREAM') ?? 'outbound';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(stream)) {
    problems.push('POSTMARK_MESSAGE_STREAM: letters, digits, dashes and underscores only');
  }
  const user = read(source, 'POSTMARK_WEBHOOK_USER');
  const password = read(source, 'POSTMARK_WEBHOOK_PASSWORD');
  if (user !== undefined && password === undefined) {
    problems.push('POSTMARK_WEBHOOK_PASSWORD: required with POSTMARK_WEBHOOK_USER');
  }
  if (password !== undefined && user === undefined) {
    problems.push('POSTMARK_WEBHOOK_USER: required with POSTMARK_WEBHOOK_PASSWORD');
  }
  if (user !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    problems.push('POSTMARK_WEBHOOK_USER: letters, digits, dots, dashes and underscores only');
  }
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
    problems.push(
      `POSTMARK_WEBHOOK_PASSWORD: at least ${String(MIN_PASSWORD_LENGTH)} characters, random`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return {
    messageStream: stream,
    webhook: user !== undefined && password !== undefined ? { user, password } : undefined,
  };
}

/**
 * The headers for one email: the stream, and the outbox id as metadata, which Postmark sends
 * back in its webhooks. Only when the relay is Postmark's, so other relays get a clean message.
 */
export function postmarkHeaders(
  smtpUrl: string,
  outboxId: string,
  messageStream: string,
): Record<string, string> {
  let host: string;
  try {
    host = new URL(smtpUrl).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (host !== POSTMARK_SMTP_HOST) return {};
  return {
    'X-PM-Message-Stream': messageStream,
    [`X-PM-Metadata-${OUTBOX_METADATA_KEY}`]: outboxId,
  };
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Checks an Authorization header against the webhook's user and password, in constant time. */
export function webhookCredentialsMatch(
  authorization: string | undefined,
  expected: PostmarkWebhookCredentials,
): boolean {
  const match = /^Basic ([A-Za-z0-9+/=]{1,512})$/.exec(authorization?.trim() ?? '');
  const decoded = match?.[1] === undefined ? '' : Buffer.from(match[1], 'base64').toString('utf8');
  // Hashing first makes both sides the same length, so the comparison leaks nothing.
  const same = timingSafeEqual(digest(decoded), digest(`${expected.user}:${expected.password}`));
  return match !== null && same;
}
