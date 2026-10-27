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
