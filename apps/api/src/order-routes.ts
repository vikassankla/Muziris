import type { AdminPermission } from '@muziris/access';
import type { Database } from '@muziris/db';
import { decimalToString, toDecimalString } from '@muziris/money';
import {
  findOrderById,
  listOrders,
  listOrdersQuerySchema,
  ORDER_TRANSITIONS,
  orderHistory,
  orderWorkflow,
  transitionOrder,
  type Order,
  type OrderSummary,
} from '@muziris/orders';
import { availableTransitions } from '@muziris/workflow';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission, type AdminAccessVariables } from './access-routes.js';
import { requireSession, trustedOriginGuard } from './auth-routes.js';
import type { Logger } from './logger.js';
import { HttpProblem } from './problem.js';

// Orders under /admin/v1/orders (ADR 0016): list, view with history, and workflow transitions.
// Placing orders is the storefront's; admins only move them through the order workflow.

export interface OrderRouteDependencies {
  db: Database;
  logger: Logger;
  now: () => Date;
  /** Origins allowed to send state-changing requests with cookies. */
  trustedOrigins: ReadonlySet<string>;
}

interface OrderEnv {
  Variables: AdminAccessVariables;
}

const idParam = z.uuid();

/** Query strings carry text only; this turns the page size into a number. */
const limitText = z
  .string()
  .regex(/^\d{1,4}$/, 'Use a whole number')
  .transform(Number)
  .optional();
const queryText = z.string().max(100).optional();

/** Drops keys whose value is undefined, for exactOptionalPropertyTypes. */
function defined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

const listOrdersQuery = z
  .object({
    websiteId: queryText,
    customerId: queryText,
    step: queryText,
    after: queryText,
    limit: limitText,
  })
  .transform((q) => listOrdersQuerySchema.parse(defined(q)));

const transitionBody = z.object({
  transition: z.enum(ORDER_TRANSITIONS),
  note: z.string().trim().min(1).max(500).optional(),
  /** The version the admin last saw; a different one refuses with 409 stale_version. */
  expectedVersion: z.int().min(1).optional(),
});

function summaryJson(order: OrderSummary) {
  return {
    id: order.id,
    number: order.number,
    websiteId: order.websiteId,
    customerId: order.customerId,
    customerName: order.customerName,
    placedBy: order.placedBy,
    step: order.step,
    purchaseOrderNumber: order.purchaseOrderNumber,
    grandTotal: toDecimalString(order.grandTotal),
    currency: order.grandTotal.currency,
    placedAt: order.placedAt,
  };
}

function orderJson(order: Order) {
  return {
    ...summaryJson(order),
    paymentMethod: order.paymentMethod,
    paymentTermDays: order.paymentTermDays,
    dueOn: order.dueOn,
    shippingMethod: order.shippingMethod,
    taxProvider: order.taxProvider,
    sellerTaxId: order.sellerTaxId,
    taxExemptionCertificate: order.taxExemptionCertificate,
    subtotal: toDecimalString(order.subtotal),
    discount: toDecimalString(order.discount),
    shipping: toDecimalString(order.shipping),
    shippingDiscount: toDecimalString(order.shippingDiscount),
    tax: toDecimalString(order.tax),
    lines: order.lines.map((l) => ({
      lineNo: l.lineNo,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      unitCode: l.unitCode,
      unitName: l.unitName,
      quantity: decimalToString(l.quantity),
      unitPrice: toDecimalString(l.unitPrice),
      subtotal: toDecimalString(l.subtotal),
      discount: toDecimalString(l.discount),
      net: toDecimalString(l.net),
      taxCode: l.taxCode,
    })),
    taxes: order.taxes.map((t) => ({
      lineNo: t.lineNo,
      name: t.name,
      rate: t.rate,
      taxable: toDecimalString(t.taxable),
      amount: toDecimalString(t.amount),
    })),
    billingAddress: order.billingAddress,
    shippingAddress: order.shippingAddress,
  };
}

/** An order with its history, its workflow version and the transitions open from its step. */
async function orderView(db: Database, order: Order) {
  const history = await orderHistory(db, order.id);
  return {
    order: orderJson(order),
    version: history.at(-1)?.sequence ?? 0,
    transitions: availableTransitions(orderWorkflow, order.step),
    history: history.map((e) => ({
      sequence: e.sequence,
      transition: e.transition,
      fromStep: e.fromStep,
      toStep: e.toStep,
      actor: e.actor,
      note: e.note,
      occurredAt: e.occurredAt,
    })),
  };
}

/** Orders, under /admin/v1/orders. */
export function orderRoutes(deps: OrderRouteDependencies): Hono<OrderEnv> {
  const app = new Hono<OrderEnv>();
  const need = (permission: AdminPermission) => requirePermission(permission, deps);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', trustedOriginGuard(deps.trustedOrigins));
  app.use('*', requireSession('admin', deps));

  app.get('/', need('order.view'), async (c) => {
    const page = await listOrders(deps.db, listOrdersQuery.parse(c.req.query()));
    return c.json({ orders: page.orders.map(summaryJson), nextAfter: page.nextAfter });
  });

  app.get('/:orderId', need('order.view'), async (c) => {
    const order = await findOrderById(deps.db, idParam.parse(c.req.param('orderId')));
    if (!order) throw new HttpProblem(404, 'order_not_found', 'No such order');
    return c.json(await orderView(deps.db, order));
  });

  app.post('/:orderId/transitions', need('order.manage'), async (c) => {
    const orderId = idParam.parse(c.req.param('orderId'));
    const input = transitionBody.parse(await body(c));
    if (!(await findOrderById(deps.db, orderId))) {
      throw new HttpProblem(404, 'order_not_found', 'No such order');
    }
    const result = await transitionOrder(deps.db, {
      orderId,
      transition: input.transition,
      actor: { type: 'admin_user', id: c.get('user').id },
      now: deps.now(),
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });
    if (!result.ok) {
      const { refusal } = result;
      switch (refusal.code) {
        case 'stale_version':
          throw new HttpProblem(
            409,
            'stale_version',
            'The order changed since you looked at it',
            `The order is at version ${refusal.actualVersion}, not ${refusal.expectedVersion}`,
          );
        case 'not_allowed_from_step':
          throw new HttpProblem(
            409,
            'transition_not_allowed',
            'The order cannot make this move from its step',
            `${refusal.transition} is not open from ${refusal.step}`,
          );
        case 'guard_failed':
          throw new HttpProblem(409, 'transition_not_allowed', 'The order cannot make this move');
        case 'unknown_transition':
          throw new HttpProblem(400, 'unknown_transition', 'No such transition');
      }
    }
    deps.logger.info(
      {
        requestId: c.get('requestId'),
        userId: c.get('user').id,
        orderId,
        transition: input.transition,
        step: result.order.step,
      },
      'orders.transitioned',
    );
    return c.json(await orderView(deps.db, result.order));
  });

  return app;
}
