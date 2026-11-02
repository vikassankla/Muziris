import { createRoute, useRouter } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { Badge, Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { cn } from '../lib/cn.js';
import {
  getOrder,
  transitionOrder,
  type OrderPayment,
  type OrderStep,
  type OrderView,
} from '../lib/endpoints.js';
import { formatAmount, formatDate, formatDateTime, type DisplayContext } from '../lib/format.js';
import {
  addressLines,
  HAPPY_PATH,
  isZeroAmount,
  orderDisplay,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONES,
  paymentTerm,
  STEP_LABELS,
  STEP_TONES,
  taxTotals,
  TRANSACTION_OUTCOMES,
  TRANSITION_LABELS,
  transitionLabel,
} from '../lib/orders.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { authedRoute } from './authed.js';

export const orderDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders/$orderId',
  loader: ({ params, abortController }) => getOrder(params.orderId, abortController.signal),
  component: OrderDetailPage,
});

/** What each move reads as in the history: "Admin confirmed the order". */
const HISTORY_TEXT: Record<string, string> = {
  confirm: 'confirmed the order',
  decline: 'declined the order',
  start_processing: 'started processing',
  complete: 'marked the order delivered',
};

const ACTORS: Record<string, string> = {
  buyer_user: 'Buyer user',
  admin_user: 'Admin',
  system: 'Muziris',
};

function OrderDetailPage() {
  const view = orderDetailRoute.useLoaderData();
  const { order } = view;
  const ctx = orderDisplay(order.currency);
  const manage = can(useSession(), 'order.manage');
  const { pending, problem, submit } = useSubmit();
  const [declining, setDeclining] = useState(false);
  const router = useRouter();

  const move = (transition: string) =>
    submit(() => transitionOrder(order.id, { transition, expectedVersion: view.version }), {
      title: `${transitionLabel(transition)}: done`,
      description: order.number,
    });

  const actions = manage
    ? view.transitions.map((transition) =>
        TRANSITION_LABELS[transition]?.destructive ? (
          <Button
            key={transition}
            variant="outline"
            disabled={pending}
            onClick={() => {
              setDeclining(true);
            }}
          >
            {transitionLabel(transition)}…
          </Button>
        ) : (
          <Button key={transition} disabled={pending} onClick={() => void move(transition)}>
            {transitionLabel(transition)}
          </Button>
        ),
      )
    : null;

  return (
    <Page>
      <Breadcrumbs
        crumbs={[{ label: 'Sales' }, { label: 'Orders', to: '/orders' }, { label: order.number }]}
      />
      <PageHeader
        title={`Order ${order.number}`}
        badges={
          <>
            <Badge variant={STEP_TONES[order.step]}>{STEP_LABELS[order.step]}</Badge>
            {view.payment ? (
              <Badge variant={PAYMENT_STATUS_TONES[view.payment.status]}>
                {PAYMENT_STATUS_LABELS[view.payment.status]}
              </Badge>
            ) : (
              <Tag>{paymentTerm(order.paymentTermDays)}</Tag>
            )}
          </>
        }
        description={`${order.customerName} · placed on ${formatDateTime(order.placedAt, ctx)}`}
        actions={actions && actions.length > 0 ? actions : null}
      />
      {problem ? <ProblemAlert problem={problem} /> : null}
      <Progress view={view} ctx={ctx} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 gap-4">
          <Lines view={view} ctx={ctx} />
          <div className="grid gap-4 md:grid-cols-2">
            <AddressCard title="Shipping address" lines={addressLines(order.shippingAddress)} />
            <AddressCard title="Billing address" lines={addressLines(order.billingAddress)} />
          </div>
        </div>
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Payment</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Method</dt>
                <dd className="m-0">{PAYMENT_METHOD_LABELS[order.paymentMethod]}</dd>
                {order.dueOn ? (
                  <>
                    <dt className="text-muted-foreground">Payment term</dt>
                    <dd className="m-0">{paymentTerm(order.paymentTermDays)}</dd>
                    <dt className="text-muted-foreground">Due</dt>
                    <dd className="m-0">{formatDate(`${order.dueOn}T12:00:00Z`, ctx)}</dd>
                  </>
                ) : null}
                {view.payment ? <PaymentRows payment={view.payment} ctx={ctx} /> : null}
                <dt className="text-muted-foreground">Buyer PO</dt>
                <dd className="m-0 font-mono text-[12.5px]">
                  {order.purchaseOrderNumber ?? 'None'}
                </dd>
                <dt className="text-muted-foreground">Shipping</dt>
                <dd className="m-0">{order.shippingMethod}</dd>
                {order.sellerTaxId ? (
                  <>
                    <dt className="text-muted-foreground">
                      {order.currency === 'INR' ? 'Our GSTIN' : 'Our permit'}
                    </dt>
                    <dd className="m-0 font-mono text-[12.5px]">{order.sellerTaxId}</dd>
                  </>
                ) : null}
                {order.taxExemptionCertificate ? (
                  <>
                    <dt className="text-muted-foreground">Exemption</dt>
                    <dd className="m-0 font-mono text-[12.5px]">{order.taxExemptionCertificate}</dd>
                  </>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          {view.payment?.started ? <Transactions payment={view.payment} ctx={ctx} /> : null}
          <History view={view} ctx={ctx} />
        </div>
      </div>
      {manage && view.transitions.includes('decline') ? (
        <ConfirmDialog
          open={declining}
          onOpenChange={setDeclining}
          title={`Decline order ${order.number}?`}
          description="The buyer will see the order as declined. This cannot be undone."
          confirmLabel="Decline order"
          onConfirm={async () => {
            await transitionOrder(order.id, {
              transition: 'decline',
              expectedVersion: view.version,
            });
            toast.success('Order declined', { description: order.number });
            await router.invalidate();
          }}
        />
      ) : null}
    </Page>
  );
}

/** The steps the order has passed, the one it is at, and those still to come. */
function Progress({ view, ctx }: { view: OrderView; ctx: DisplayContext }) {
  const step = view.order.step;
  const reached = new Map(view.history.map((e) => [e.toStep, e.occurredAt]));
  const path: OrderStep[] = step === 'declined' ? ['new', 'declined'] : [...HAPPY_PATH];
  const at = path.indexOf(step);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Order progress">
      {path.map((s, i) => {
        const state = i < at || step === 'completed' ? 'done' : i === at ? 'current' : 'todo';
        const when = reached.get(s);
        return (
          <li
            key={s}
            aria-current={state === 'current' ? 'step' : undefined}
            className={cn(
              'flex min-w-[150px] flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm',
              state === 'current' && 'border-primary',
              state === 'todo' && 'text-muted-foreground',
            )}
          >
            {state === 'done' ? <Check className="size-4 text-success" aria-hidden="true" /> : null}
            <span className="font-[550]">{STEP_LABELS[s]}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {when ? formatDateTime(when, ctx) : state === 'todo' ? 'To do' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Lines({ view, ctx }: { view: OrderView; ctx: DisplayContext }) {
  const { order } = view;
  const totals: { label: string; amount: string; strong?: boolean }[] = [
    { label: 'Subtotal', amount: order.subtotal },
  ];
  if (!isZeroAmount(order.discount))
    totals.push({ label: 'Discount', amount: `-${order.discount}` });
  totals.push({ label: 'Shipping', amount: order.shipping });
  if (!isZeroAmount(order.shippingDiscount)) {
    totals.push({ label: 'Shipping discount', amount: `-${order.shippingDiscount}` });
  }
  totals.push(...taxTotals(order));
  if (order.taxes.length === 0) totals.push({ label: 'Tax', amount: order.tax });
  totals.push({ label: 'Total', amount: order.grandTotal, strong: true });
  const lineCount = order.lines.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Lines{' '}
          <span className="font-normal text-muted-foreground">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Line total</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {order.lines.map((line) => (
              <TableRow key={line.lineNo}>
                <TableCell className="min-w-[220px] whitespace-normal">
                  <div className="font-[550]">{line.productName}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {line.sku}
                    {line.taxCode ? ` · ${line.taxCode}` : ''}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.quantity} {line.unitName}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatAmount(line.unitPrice, ctx)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatAmount(line.net, ctx)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <dl className="m-0 ml-auto grid min-w-[280px] grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
          {totals.map((t) => (
            <div key={t.label} className="contents">
              <dt className={t.strong ? 'font-[650]' : 'text-muted-foreground'}>{t.label}</dt>
              <dd className={cn('m-0 text-right font-mono tabular-nums', t.strong && 'font-[650]')}>
                {formatAmount(t.amount, ctx)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function AddressCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <address className="text-sm not-italic">
          {lines.map((line, i) => (
            <div key={i} className={i === 0 ? 'font-[550]' : undefined}>
              {line}
            </div>
          ))}
        </address>
      </CardContent>
    </Card>
  );
}

function History({ view, ctx }: { view: OrderView; ctx: DisplayContext }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Status history</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="m-0 grid list-none gap-3 p-0 text-sm">
          {[...view.history].reverse().map((entry) => (
            <li key={entry.sequence}>
              <div>
                <span className="font-[550]">{ACTORS[entry.actor.type] ?? entry.actor.type}</span>{' '}
                {entry.transition
                  ? (HISTORY_TEXT[entry.transition] ?? entry.transition)
                  : 'placed the order'}
              </div>
              {entry.note ? <div className="text-muted-foreground">{entry.note}</div> : null}
              <div className="text-xs text-muted-foreground">
                {formatDateTime(entry.occurredAt, ctx)}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/** An online payment's status as the gateway last reported it (ADR 0019). */
function PaymentRows({ payment, ctx }: { payment: OrderPayment; ctx: DisplayContext }) {
  return (
    <>
      <dt className="text-muted-foreground">Status</dt>
      <dd className="m-0">
        <Badge variant={PAYMENT_STATUS_TONES[payment.status]}>
          {PAYMENT_STATUS_LABELS[payment.status]}
        </Badge>
      </dd>
      <dt className="text-muted-foreground">Amount</dt>
      <dd className="m-0 font-mono tabular-nums">{formatAmount(payment.amount, ctx)}</dd>
      {payment.started ? (
        <>
          {isZeroAmount(payment.refunded) ? null : (
            <>
              <dt className="text-muted-foreground">Refunded</dt>
              <dd className="m-0 font-mono tabular-nums">{formatAmount(payment.refunded, ctx)}</dd>
            </>
          )}
          {payment.paidAt ? (
            <>
              <dt className="text-muted-foreground">Paid</dt>
              <dd className="m-0">{formatDateTime(payment.paidAt, ctx)}</dd>
            </>
          ) : null}
          {payment.gatewayRef ? (
            <>
              <dt className="text-muted-foreground">Gateway ref</dt>
              <dd className="m-0 font-mono text-[12.5px] break-all">{payment.gatewayRef}</dd>
            </>
          ) : null}
        </>
      ) : (
        <>
          <dt className="text-muted-foreground">Gateway</dt>
          <dd className="m-0 text-muted-foreground">The buyer has not started paying</dd>
        </>
      )}
    </>
  );
}

/** Every gateway event recorded against the payment, oldest first. Refunds are made in the gateway. */
function Transactions({
  payment,
  ctx,
}: {
  payment: Extract<OrderPayment, { started: true }>;
  ctx: DisplayContext;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateway events</CardTitle>
      </CardHeader>
      <CardContent>
        {payment.transactions.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">Nothing from the gateway yet.</p>
        ) : (
          <ol className="m-0 grid list-none gap-3 p-0 text-sm">
            {payment.transactions.map((t) => (
              <li key={t.eventId}>
                <div className="font-mono text-[12.5px]">{t.eventType}</div>
                <div className="text-muted-foreground">
                  {TRANSACTION_OUTCOMES[t.outcome] ?? t.outcome}
                  {t.amount ? ` · ${formatAmount(t.amount, ctx)}` : ''}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(t.receivedAt, ctx)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
