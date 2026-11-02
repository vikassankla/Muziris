import { pino, type Logger } from 'pino';

export type { Logger };

/** Field paths whose values must never appear in logs. */
export const REDACTED_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'databaseUrl',
  // Payment gateway keys and the secrets they hand out (ADR 0019).
  'secretKey',
  '*.secretKey',
  'keySecret',
  '*.keySecret',
  'webhookSecret',
  '*.webhookSecret',
  'clientSecret',
  '*.clientSecret',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  // The SMTP URL can carry the mail server's password (ADR 0020).
  'smtpUrl',
  '*.smtpUrl',
  'SMTP_URL',
];

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'muziris-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    destination,
  );
}
