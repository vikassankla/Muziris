// Mail configuration (ADR 0020), from the environment only. SMTP_URL can hold a password, so
// it is a secret: errors name the variable, never its value, and it is never logged.

export interface MailConfig {
  /** smtp:// or smtps://; unset means emails queue up and are not sent. */
  smtpUrl: string | undefined;
  /** The From header, such as "Muziris <orders@example.com>". */
  from: string;
  /** The storefront's public origin and base path, without a trailing slash, for links. */
  storefrontUrl: string;
}

export const MAIL_ENV_NAMES = ['SMTP_URL', 'MAIL_FROM', 'STOREFRONT_PUBLIC_URL'] as const;

const DEV_DEFAULTS = {
  from: 'Muziris <no-reply@muziris.localhost>',
  storefrontUrl: 'http://localhost:5174',
};

function read(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name]?.trim();
  return value === '' ? undefined : value;
}

/** Throws with every problem at once, naming variables only. */
export function mailConfigFromEnv(
  source: Record<string, string | undefined>,
  options: { production: boolean },
): MailConfig {
  const problems: string[] = [];
  const smtpUrl = read(source, 'SMTP_URL');
  if (smtpUrl !== undefined && !/^smtps?:\/\/[^\s]+$/.test(smtpUrl)) {
    problems.push('SMTP_URL: expected smtp:// or smtps://');
  }
  const from = read(source, 'MAIL_FROM');
  if (from !== undefined && !/^([^<>\r\n]*<)?[^@\s<>]+@[^@\s<>]+>?$/.test(from)) {
    problems.push('MAIL_FROM: expected an address such as "Shop <orders@example.com>"');
  }
  const storefront = read(source, 'STOREFRONT_PUBLIC_URL');
  let storefrontUrl: string | undefined;
  if (storefront !== undefined) {
    try {
      const url = new URL(storefront);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('protocol');
      if (options.production && url.protocol !== 'https:') {
        problems.push('STOREFRONT_PUBLIC_URL: production links must use https');
      }
      if (url.search || url.hash || url.username || url.password) throw new TypeError('extra');
      storefrontUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      problems.push('STOREFRONT_PUBLIC_URL: expected an http(s) URL with no query or fragment');
    }
  }
  if (options.production) {
    for (const [name, value] of [
      ['SMTP_URL', smtpUrl],
      ['MAIL_FROM', from],
      ['STOREFRONT_PUBLIC_URL', storefront],
    ] as const) {
      if (value === undefined) problems.push(`${name}: required in production`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return {
    smtpUrl,
    from: from ?? DEV_DEFAULTS.from,
    storefrontUrl: storefrontUrl ?? DEV_DEFAULTS.storefrontUrl,
  };
}
