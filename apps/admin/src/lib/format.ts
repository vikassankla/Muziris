import { format as formatMoney, moneyFromDecimal, parseDecimal } from '@muziris/money';

/**
 * How a website shows numbers and dates (Tokens board, "Numbers, money, dates"). Until the
 * websites API exists the admin offers two fixed choices; see website.tsx.
 */
export interface DisplayContext {
  locale: 'en-IN' | 'en-US';
  currency: 'INR' | 'USD';
  timeZone: string;
}

/** ₹12,34,567.50 for en-IN, $1,234,567.50 for en-US. The amount is a decimal string. */
export function formatAmount(amount: string, ctx: DisplayContext): string {
  return formatMoney(moneyFromDecimal(amount, ctx.currency), ctx.locale);
}

/** Groups the digits of a whole number the way the locale does: 12,34,567 or 1,234,567. */
function groupDigits(digits: string, locale: DisplayContext['locale']): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const size = locale === 'en-IN' ? 2 : 3;
  const groups: string[] = [];
  for (let end = rest.length; end > 0; end -= size) {
    groups.unshift(rest.slice(Math.max(0, end - size), end));
  }
  return `${groups.join(',')},${last3}`;
}

/**
 * A quantity with every decimal place its product unit allows: "2.000 kg", "1,250 Each".
 * Units with decimals show their code (kg, m); whole-number units show their name (Each, Box).
 * The quantity is a decimal string, never a JavaScript number.
 */
export function formatQuantity(
  quantity: string,
  unit: { code: string; name: string; precision: number },
  ctx: DisplayContext,
): string {
  const decimal = parseDecimal(quantity);
  const negative = decimal.units < 0n;
  const digits = (negative ? -decimal.units : decimal.units)
    .toString()
    .padStart(decimal.scale + 1, '0');
  const whole = digits.slice(0, digits.length - decimal.scale) || '0';
  let fraction = digits.slice(digits.length - decimal.scale);
  fraction = fraction.padEnd(unit.precision, '0').slice(0, Math.max(unit.precision, 0));
  const number = `${negative ? '-' : ''}${groupDigits(whole, ctx.locale)}${fraction ? `.${fraction}` : ''}`;
  return `${number} ${unit.precision > 0 ? unit.code : unit.name}`;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function formatter(ctx: DisplayContext, withTime: boolean): Intl.DateTimeFormat {
  const key = `${ctx.locale}|${ctx.timeZone}|${String(withTime)}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(ctx.locale, {
      timeZone: ctx.timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...(withTime
        ? {
            hour: ctx.locale === 'en-US' ? 'numeric' : '2-digit',
            minute: '2-digit',
            hour12: ctx.locale === 'en-US',
            // IST in India; the generic "CT" in the US, as on the Tokens board.
            timeZoneName: ctx.locale === 'en-US' ? 'shortGeneric' : 'short',
          }
        : {}),
    });
    dateFormats.set(key, f);
  }
  return f;
}

/** "27 Oct 2026" or "Oct 27, 2026", in the website's time zone. */
export function formatDate(iso: string, ctx: DisplayContext): string {
  return formatter(ctx, false).format(new Date(iso));
}

/** "27 Oct 2026, 14:05 IST" or "Oct 27, 2026, 2:05 PM CT", in the website's time zone. */
export function formatDateTime(iso: string, ctx: DisplayContext): string {
  return formatter(ctx, true).format(new Date(iso));
}

/** A count with the locale's grouping, for table cells: 1,284 or 12,840. */
export function formatCount(count: number, ctx: DisplayContext): string {
  return groupDigits(String(Math.trunc(count)), ctx.locale);
}
