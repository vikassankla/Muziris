import type { Database } from '@muziris/db';
import { findSuppression, type SuppressionReason } from '@muziris/notifications';

// The new-order email address on the Settings page (ADR 0032): when it is suppressed, the seller
// hears of no new orders, so the page says so before an order goes unnoticed.

const WHY: Record<SuppressionReason, string> = {
  hard_bounce: 'it bounced on',
  spam_complaint: 'an email to it was marked as spam on',
  smtp_rejected: 'the mail server refused it on',
  manual: 'an admin added it to the suppressed addresses on',
};

/** Plain-language warnings for a notifications.order_email value. */
export async function orderEmailWarnings(db: Database, value: unknown): Promise<string[]> {
  if (typeof value !== 'string' || value === '') return [];
  const suppression = await findSuppression(db, value);
  if (!suppression) return [];
  const day = suppression.firstSeenAt.toISOString().slice(0, 10);
  return [
    `New order emails to this address are not sent: ${WHY[suppression.reason]} ${day}. Fix the address, or remove it under System > Emails > Suppressed addresses.`,
  ];
}
