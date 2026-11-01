import type { CreatedInvitation, InvitationHooks } from '@muziris/customers';
import type { Database, Transaction } from '@muziris/db';
import { findUserById, type AuthenticatedUser } from '@muziris/identity';
import { toDecimalString, type Money as AnyMoney } from '@muziris/money';
import {
  ORDER_EMAIL_SETTING,
  queueEmail,
  renderEmail,
  SENSITIVE_KINDS,
  type EmailContext,
  type EmailData,
  type MailConfig,
} from '@muziris/notifications';
import type { Order, OrderTransition, PlacedOrder } from '@muziris/orders';
import type { Payment, PaymentHooks } from '@muziris/payments';
import { findWebsite, findWebsiteByCode, getSetting, type Website } from '@muziris/platform';
import type { Logger } from './logger.js';

// Turns the domain's changes into queued emails (ADR 0020, docs/notifications.md). Everything an
// email needs is read before the change's transaction starts; the hooks only render and insert,
// in that transaction, so they hold no second connection and an email exists only if its change
// committed.

export interface EmailDependencies {
  db: Database;
  logger: Logger;
  mail: MailConfig;
  /** The code of the website the public storefront serves; invitations come from it. */
  storefrontWebsite: string;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  terms: 'On terms',
  stripe: 'Card (Stripe)',
  razorpay: 'Razorpay',
};

/** The buyer emails a transition sends; other moves send none. */
const TRANSITION_KINDS: Partial<
  Record<OrderTransition, 'order_confirmed' | 'order_declined' | 'order_completed'>
> = {
  confirm: 'order_confirmed',
  decline: 'order_declined',
  complete: 'order_completed',
};

function money(value: AnyMoney) {
  return { amount: toDecimalString(value), currency: value.currency };
}

function context(website: Website): EmailContext {
  return { shopName: website.name, locale: website.defaultLocale, timeZone: website.timeZone };
}

export function createEmails(deps: EmailDependencies) {
  const { mail } = deps;
  const orderUrl = (number: string) => `${mail.storefrontUrl}/orders/${encodeURIComponent(number)}`;

  async function queue(
    tx: Transaction,
    key: string,
    to: string,
    data: EmailData,
    ctx: EmailContext,
    now: Date,
  ) {
    await queueEmail(tx, {
      kind: data.kind,
      key,
      to,
      locale: ctx.locale,
      message: renderEmail(data, ctx),
      sensitive: SENSITIVE_KINDS.has(data.kind),
      now,
    });
  }

  /** Reads the buyer and website of an order, for an email about it. */
  async function audience(order: { placedBy: string; websiteId: string }) {
    const [buyer, website] = await Promise.all([
      findUserById(deps.db, order.placedBy),
      findWebsite(deps.db, order.websiteId),
    ]);
    return buyer && website ? { buyer, website } : undefined;
  }

  return {
    /** The invitation email, with the accept link that carries the token. */
    async invitation(customerName: string): Promise<InvitationHooks> {
      const website = await findWebsiteByCode(deps.db, deps.storefrontWebsite);
      if (!website) {
        deps.logger.warn({ website: deps.storefrontWebsite }, 'emails.storefront_website_missing');
      }
      const ctx: EmailContext = website
        ? context(website)
        : { shopName: 'Muziris', locale: 'en-IN', timeZone: 'Asia/Kolkata' };
      return {
        inTransaction: (tx: Transaction, created: CreatedInvitation) =>
          queue(
            tx,
            `buyer_invitation:${created.invitation.id}`,
            created.invitation.email,
            {
              kind: 'buyer_invitation',
              displayName: created.invitation.displayName,
              customerName,
              // In the fragment, so the token never reaches a server log or a Referer header.
              acceptUrl: `${mail.storefrontUrl}/accept-invitation#token=${created.token}`,
              expiresAt: created.invitation.expiresAt,
            },
            ctx,
            created.invitation.createdAt,
          ),
      };
    },

    /** "Order received" to the buyer, and "new order" to the seller's order address if set. */
    async orderPlaced(buyer: AuthenticatedUser, website: Website, now: Date) {
      const staff = (
        await getSetting(deps.db, ORDER_EMAIL_SETTING, {
          websiteId: website.id,
          organizationId: website.organizationId,
        })
      ).value;
      const ctx = context(website);
      return async (tx: Transaction, order: PlacedOrder) => {
        await queue(
          tx,
          `order_placed:${order.id}`,
          buyer.email,
          {
            kind: 'order_placed',
            buyerName: buyer.displayName,
            orderNumber: order.number,
            total: money(order.grandTotal),
            orderUrl: orderUrl(order.number),
            purchaseOrderNumber: order.purchaseOrderNumber,
            dueOn: order.dueOn,
          },
          ctx,
          now,
        );
        if (staff !== '') {
          await queue(
            tx,
            `order_received:${order.id}`,
            staff,
            {
              kind: 'order_received',
              orderNumber: order.number,
              customerName: order.customerName,
              total: money(order.grandTotal),
              purchaseOrderNumber: order.purchaseOrderNumber,
              paymentMethod: PAYMENT_METHOD_LABELS[order.paymentMethod] ?? order.paymentMethod,
            },
            ctx,
            now,
          );
        }
      };
    },

    /** The buyer's email for a confirm, decline or complete; undefined when the move sends none. */
    async orderTransition(order: Order, transition: OrderTransition, now: Date) {
      const kind = TRANSITION_KINDS[transition];
      if (!kind) return undefined;
      const who = await audience(order);
      if (!who) return undefined;
      const ctx = context(who.website);
      return (tx: Transaction, event: { note: string | null }) => {
        const base = {
          buyerName: who.buyer.displayName,
          orderNumber: order.number,
          total: money(order.grandTotal),
          orderUrl: orderUrl(order.number),
          purchaseOrderNumber: order.purchaseOrderNumber,
          dueOn: order.dueOn,
        };
        return queue(
          tx,
          `${kind}:${order.id}`,
          who.buyer.email,
          kind === 'order_declined' ? { kind, ...base, note: event.note } : { kind, ...base },
          ctx,
          now,
        );
      };
    },

    /** "Payment received" or "payment failed" to the buyer who placed the order. */
    async payment(order: Order | undefined, now: Date): Promise<PaymentHooks> {
      const who = order ? await audience(order) : undefined;
      if (!order || !who) return {};
      const ctx = context(who.website);
      return {
        onStatusChanged: async (tx: Transaction, change: { payment: Payment; to: string }) => {
          const kind =
            change.to === 'paid'
              ? 'payment_received'
              : change.to === 'failed' || change.to === 'cancelled'
                ? 'payment_failed'
                : undefined;
          if (!kind) return;
          await queue(
            tx,
            // A payment can fail more than once before it succeeds; each failure is told once.
            kind === 'payment_received'
              ? `payment_received:${change.payment.id}`
              : `payment_failed:${change.payment.id}:${now.toISOString()}`,
            who.buyer.email,
            {
              kind,
              buyerName: who.buyer.displayName,
              orderNumber: order.number,
              amount: money(order.grandTotal),
              orderUrl: orderUrl(order.number),
            },
            ctx,
            now,
          );
        },
      };
    },
  };
}

export type Emails = ReturnType<typeof createEmails>;
