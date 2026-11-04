import type { NotificationKind } from './db/schema.js';

// The pilot's email templates (ADR 0020, docs/notifications.md). Each kind is a function of
// plain data: the text in English for both pilot locales (en-IN, en-US), with money and dates
// formatted for the locale and the website's time zone. Every value is escaped in the HTML.

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface Money {
  /** A decimal string such as "57364.00". */
  amount: string;
  currency: string;
}

/** Who the email is from and how dates read: the website's name, locale and time zone. */
export interface EmailContext {
  shopName: string;
  locale: string;
  timeZone: string;
}

interface OrderData {
  buyerName: string;
  orderNumber: string;
  total: Money;
  /** The order page in the storefront. */
  orderUrl: string;
  purchaseOrderNumber: string | null;
  /** The payment due date on terms (YYYY-MM-DD), or null when paid online. */
  dueOn: string | null;
}

export type EmailData =
  | {
      kind: 'buyer_invitation';
      displayName: string;
      customerName: string;
      acceptUrl: string;
      expiresAt: Date;
    }
  | {
      kind: 'admin_invitation';
      displayName: string;
      /** The admin who sent it. */
      invitedByName: string;
      acceptUrl: string;
      expiresAt: Date;
    }
  | ({ kind: 'order_placed' | 'order_confirmed' | 'order_completed' } & OrderData)
  | ({ kind: 'order_declined'; note: string | null } & OrderData)
  | {
      kind: 'order_received';
      orderNumber: string;
      customerName: string;
      total: Money;
      purchaseOrderNumber: string | null;
      paymentMethod: string;
    }
  | {
      kind: 'payment_received' | 'payment_failed';
      buyerName: string;
      orderNumber: string;
      amount: Money;
      orderUrl: string;
    };

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoney(money: Money, locale: string): string {
  // A decimal string keeps every digit; Intl reads it as an exact decimal.
  return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency }).format(
    money.amount as `${number}`,
  );
}

function formatDate(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

function formatDateTime(at: Date, ctx: EmailContext): string {
  return new Intl.DateTimeFormat(ctx.locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: ctx.timeZone,
    timeZoneName: 'short',
  }).format(at);
}

/** One block of an email: a paragraph, a list of label and value rows, or a button link. */
type Block =
  { p: string } | { rows: [string, string][] } | { link: { label: string; href: string } };

function compose(ctx: EmailContext, subject: string, greeting: string, blocks: Block[]) {
  const text: string[] = [greeting, ''];
  const html: string[] = [`<p>${escapeHtml(greeting)}</p>`];
  for (const block of blocks) {
    if ('p' in block) {
      text.push(block.p, '');
      html.push(`<p>${escapeHtml(block.p)}</p>`);
    } else if ('rows' in block) {
      text.push(...block.rows.map(([label, value]) => `${label}: ${value}`), '');
      html.push(
        `<table role="presentation" cellpadding="4" cellspacing="0">${block.rows
          .map(
            ([label, value]) =>
              `<tr><td style="color:#555">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`,
          )
          .join('')}</table>`,
      );
    } else {
      text.push(`${block.link.label}: ${block.link.href}`, '');
      html.push(
        `<p><a href="${escapeHtml(block.link.href)}" style="display:inline-block;padding:10px 16px;background:#1f3a5f;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(block.link.label)}</a></p>`,
      );
    }
  }
  text.push(ctx.shopName);
  html.push(`<p style="color:#555">${escapeHtml(ctx.shopName)}</p>`);
  return {
    subject,
    text: text.join('\n'),
    html: `<!doctype html><html lang="${escapeHtml(ctx.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${html.join('')}</body></html>`,
  };
}

function orderRows(data: OrderData, locale: string): [string, string][] {
  const rows: [string, string][] = [
    ['Order', data.orderNumber],
    ['Total', formatMoney(data.total, locale)],
  ];
  if (data.purchaseOrderNumber) rows.push(['Your PO', data.purchaseOrderNumber]);
  if (data.dueOn) rows.push(['Payment due', formatDate(data.dueOn, locale)]);
  return rows;
}

/** Renders one email. Values are escaped in the HTML; links must already be absolute. */
export function renderEmail(data: EmailData, ctx: EmailContext): RenderedEmail {
  const { locale } = ctx;
  switch (data.kind) {
    case 'buyer_invitation':
      return compose(
        ctx,
        `You are invited to order from ${ctx.shopName}`,
        `Hello ${data.displayName},`,
        [
          {
            p: `You have been invited to order from ${ctx.shopName} for ${data.customerName}. Choose a password to set up your account.`,
          },
          { link: { label: 'Accept the invitation', href: data.acceptUrl } },
          {
            p: `The link works once and expires on ${formatDateTime(data.expiresAt, ctx)}. If you did not expect this email, you can ignore it.`,
          },
        ],
      );
    case 'admin_invitation':
      return compose(
        ctx,
        `You are invited to the ${ctx.shopName} admin`,
        `Hello ${data.displayName},`,
        [
          {
            p: `${data.invitedByName} invited you to work in the ${ctx.shopName} admin. Choose a password, then sign in and set up two-factor sign-in with an authenticator app.`,
          },
          { link: { label: 'Accept the invitation', href: data.acceptUrl } },
          {
            p: `The link works once and expires on ${formatDateTime(data.expiresAt, ctx)}. If you did not expect this email, you can ignore it.`,
          },
        ],
      );
    case 'order_placed':
      return compose(ctx, `Order ${data.orderNumber} received`, `Hello ${data.buyerName},`, [
        { p: 'Thank you for your order. We will confirm it shortly.' },
        { rows: orderRows(data, locale) },
        { link: { label: 'View the order', href: data.orderUrl } },
      ]);
    case 'order_confirmed':
      return compose(ctx, `Order ${data.orderNumber} confirmed`, `Hello ${data.buyerName},`, [
        { p: 'Your order is confirmed and will be prepared for shipping.' },
        { rows: orderRows(data, locale) },
        { link: { label: 'View the order', href: data.orderUrl } },
      ]);
    case 'order_declined':
      return compose(ctx, `Order ${data.orderNumber} declined`, `Hello ${data.buyerName},`, [
        { p: 'We could not accept your order.' },
        ...(data.note ? [{ p: `Reason: ${data.note}` }] : []),
        { rows: orderRows(data, locale) },
        { link: { label: 'View the order', href: data.orderUrl } },
      ]);
    case 'order_completed':
      return compose(ctx, `Order ${data.orderNumber} delivered`, `Hello ${data.buyerName},`, [
        { p: 'Your order has been delivered.' },
        { rows: orderRows(data, locale) },
        { link: { label: 'View the order', href: data.orderUrl } },
      ]);
    case 'order_received': {
      const rows: [string, string][] = [
        ['Order', data.orderNumber],
        ['Customer', data.customerName],
        ['Total', formatMoney(data.total, locale)],
        ['Payment', data.paymentMethod],
      ];
      if (data.purchaseOrderNumber) rows.push(['Buyer PO', data.purchaseOrderNumber]);
      return compose(ctx, `New order ${data.orderNumber} from ${data.customerName}`, 'Hello,', [
        { p: 'A new order is waiting to be confirmed in the admin.' },
        { rows },
      ]);
    }
    case 'payment_received':
      return compose(
        ctx,
        `Payment received for order ${data.orderNumber}`,
        `Hello ${data.buyerName},`,
        [
          { p: `We received your payment of ${formatMoney(data.amount, locale)}.` },
          { link: { label: 'View the order', href: data.orderUrl } },
        ],
      );
    case 'payment_failed':
      return compose(
        ctx,
        `Payment for order ${data.orderNumber} did not go through`,
        `Hello ${data.buyerName},`,
        [
          {
            p: `Your payment of ${formatMoney(data.amount, locale)} did not go through. You can try again from the order page.`,
          },
          { link: { label: 'Pay for the order', href: data.orderUrl } },
        ],
      );
  }
}

/** Which kinds carry a secret in their body. */
export const SENSITIVE_KINDS: ReadonlySet<NotificationKind> = new Set([
  'buyer_invitation',
  'admin_invitation',
]);
