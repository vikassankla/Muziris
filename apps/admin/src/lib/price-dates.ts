import { formatDate, type DisplayContext } from './format.js';

// A price list is active from an instant until an instant, exclusive (ADR 0011). The admin
// picks days: from the start of the first day to the end of the last, in the top bar website's
// time zone.

/** The UTC offset of a time zone on a day, such as +05:30 or -06:00. */
function offsetOn(day: string, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = name?.replace('GMT', '') ?? '';
  return offset === '' ? '+00:00' : offset;
}

/** A day plus `addDays`, as YYYY-MM-DD. */
function shiftDay(day: string, addDays: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + addDays);
  return date.toISOString().slice(0, 10);
}

/** The start of a day (plus `addDays`) in a time zone, as ISO 8601 with its offset. */
export function dayStart(day: string, timeZone: string, addDays = 0): string {
  const shifted = shiftDay(day, addDays);
  return `${shifted}T00:00:00${offsetOn(shifted, timeZone)}`;
}

/** The day an instant falls on in a time zone, as YYYY-MM-DD, for date inputs. */
export function dayOf(iso: string, timeZone: string, addDays = 0): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));
  return addDays === 0 ? day : shiftDay(day, addDays);
}

/** "1 Jan 2026 to 31 Dec 2026", "From 1 Jan 2026", "Until 31 Dec 2026" or "Always". */
export function activeDates(
  list: { activeFrom: string | null; activeUntil: string | null },
  display: DisplayContext,
): string {
  // The last day is the day before the exclusive end.
  const last =
    list.activeUntil === null
      ? null
      : formatDate(new Date(new Date(list.activeUntil).getTime() - 1).toISOString(), display);
  const first = list.activeFrom === null ? null : formatDate(list.activeFrom, display);
  if (first && last) return `${first} to ${last}`;
  if (first) return `From ${first}`;
  if (last) return `Until ${last}`;
  return 'Always';
}
