import { z } from 'zod';

const origin = z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(200).default(10),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin)),
  /** Largest request body accepted by default, in bytes. Bulk uploads go to object storage instead. */
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(50 * 1024 * 1024)
    .default(1024 * 1024),
  /**
   * How many reverse proxies (load balancer, CDN) sit in front of the API. Their
   * X-Forwarded-For entries are trusted for the client IP; leave 0 when the API faces clients.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Reads and validates configuration once at startup. On failure it reports which variables
 * are wrong without echoing their values, since some of them are secrets.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const env = result.data;
  if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.some((o) => o.startsWith('http://'))) {
    throw new Error('Invalid configuration:\n  CORS_ORIGINS: production origins must use https');
  }
  return env;
}
