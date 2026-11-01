import { createRoute, Link } from '@tanstack/react-router';
import { ClipboardList, PackageX } from 'lucide-react';
import { EmptyState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { runOperation } from '../lib/api.js';
import { formatPrice } from '../lib/format.js';
import { signInOn401 } from '../lib/guard.js';
import {
  formatDateTime,
  formatDay,
  isZero,
  STEP_LABELS,
  STEP_TONES,
  taxTotals,
} from '../lib/orders.js';
import { Order, Orders, type OrderResult } from '../operations/generated.js';
import { authedRoute } from './authed.js';

export const ORDERS_PAGE_SIZE = 20;

interface OrdersSearch {
  after?: string;
}

export const ordersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders',
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    const after = search['after'];
    return typeof after === 'string' && after.length > 0 && after.length <= 200 ? { after } : {};
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, location, abortController }) => {
    try {
      return await runOperation(
        Orders,
        { first: ORDERS_PAGE_SIZE, ...(deps.after ? { after: deps.after } : {}) },
        { signal: abortController.signal },
      );
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: OrdersPage,
});

function OrdersPage() {
  const data = ordersRoute.useLoaderData();
  const { after } = ordersRoute.useSearch();
  const { shell } = authedRoute.useRouteContext();
  const { locale, timeZone } = shell.website;
  const orders = data.orders.nodes;

  return (
    <>
      <div>
        <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">Orders</h1>
        <p className="m-0 mt-1 text-muted-foreground">
          Orders you may see for {shell.viewer.customer.name}, newest first.
        </p>
      </div>
      {orders.length === 0 && after === undefined ? (
        <EmptyState icon={<ClipboardList />} title="No orders yet">
          Orders you place appear here, with their status and totals.
        </EmptyState>
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead>Order</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Your PO</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.number}>
                  <TableCell>
                    <Link
                      to="/orders/$number"
                      params={{ number: order.number }}
                      className="font-mono text-[12.5px] font-[550] text-foreground hover:underline"
                    >
                      {order.number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(order.placedAt, locale, timeZone)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STEP_TONES[order.step]}>{STEP_LABELS[order.step]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {order.purchaseOrderNumber ?? 'None'}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatPrice(order.grandTotal, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav
            className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground"
            aria-label="Pages"
          >
            <span className="flex-1" />
            {after !== undefined ? (
              <Link
                to="/orders"
                search={{}}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Newest
              </Link>
            ) : null}
            {data.orders.nextAfter !== null ? (
              <Link
                to="/orders"
                search={{ after: data.orders.nextAfter }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Older
              </Link>
            ) : null}
          </nav>
        </>
      )}
    </>
  );
}

export const orderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders/$number',
  loader: async ({ params, location, abortController }) => {
    try {
      return await runOperation(
        Order,
        { number: params.number },
        { signal: abortController.signal },
      );
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: OrderPage,
});

type PlacedOrder = NonNullable<OrderResult['order']>;
type Address = PlacedOrder['billingAddress'];

function OrderPage() {
  const { order } = orderRoute.useLoaderData();
  const { shell } = authedRoute.useRouteContext();
  const { locale, timeZone } = shell.website;

  if (order === null) {
    return (
      <EmptyState
        icon={<PackageX />}
        title="We can't find that order"
        action={
          <Link to="/orders" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Back to orders
          </Link>
        }
      >
        Check the order number. You see only the orders your role allows.
      </EmptyState>
    );
  }

  const money = (amount: { amount: string; currency: string }) => formatPrice(amount, locale);
  const totals: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Subtotal', value: money(order.subtotal) },
  ];
  if (!isZero(order.discount))
    totals.push({ label: 'Discount', value: `−${money(order.discount)}` });
  totals.push({ label: `Shipping (${order.shippingMethod})`, value: money(order.shipping) });
  if (!isZero(order.shippingDiscount)) {
    totals.push({ label: 'Shipping discount', value: `−${money(order.shippingDiscount)}` });
  }
  for (const tax of taxTotals(order.taxes))
    totals.push({ label: tax.label, value: money(tax.amount) });
  if (order.taxes.length === 0) totals.push({ label: 'Tax', value: money(order.tax) });
  totals.push({ label: 'Total', value: money(order.grandTotal), strong: true });

  return (
    <>
      <div>
        <Link to="/orders" className="text-meta text-muted-foreground">
          Orders
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">
            Order {order.number}
          </h1>
          <Badge variant={STEP_TONES[order.step]}>{STEP_LABELS[order.step]}</Badge>
        </div>
        <p className="m-0 mt-1 text-muted-foreground">
          {order.customerName} · placed {formatDateTime(order.placedAt, locale, timeZone)}
        </p>
      </div>
      <Card>
        <CardContent className="grid gap-4 pt-5">
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
                  <TableCell className="min-w-[200px] whitespace-normal">
                    <div className="font-[550]">{line.productName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{line.sku}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.quantity} {line.unitName}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(line.unitPrice)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {money(line.net)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <dl className="m-0 ml-auto grid min-w-[260px] grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-meta">
            {totals.map((t) => (
              <div key={t.label} className="contents">
                <dt className={t.strong ? 'font-[650]' : 'text-muted-foreground'}>{t.label}</dt>
                <dd
                  className={`m-0 text-right font-mono tabular-nums ${t.strong ? 'font-[650]' : ''}`}
                >
                  {t.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <AddressCard title="Shipping to" address={order.shippingAddress} />
        <AddressCard title="Billing to" address={order.billingAddress} />
        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta">
              <dt className="text-muted-foreground">Terms</dt>
              <dd className="m-0">
                {order.paymentTermDays === 0
                  ? 'Due on receipt'
                  : `Net ${String(order.paymentTermDays)}`}
              </dd>
              <dt className="text-muted-foreground">Due</dt>
              <dd className="m-0">{formatDay(order.dueOn, locale)}</dd>
              <dt className="text-muted-foreground">Your PO</dt>
              <dd className="m-0 font-mono text-xs">{order.purchaseOrderNumber ?? 'None'}</dd>
              {order.sellerTaxId ? (
                <>
                  <dt className="text-muted-foreground">
                    {order.currency === 'INR' ? 'Seller GSTIN' : 'Seller permit'}
                  </dt>
                  <dd className="m-0 font-mono text-xs">{order.sellerTaxId}</dd>
                </>
              ) : null}
              {order.taxExemptionCertificate ? (
                <>
                  <dt className="text-muted-foreground">Tax exemption</dt>
                  <dd className="m-0 font-mono text-xs">{order.taxExemptionCertificate}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function AddressCard({ title, address }: { title: string; address: Address }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <address className="text-meta not-italic">
          <div className="font-[550]">{address.label}</div>
          <div>{address.line1}</div>
          {address.line2 ? <div>{address.line2}</div> : null}
          <div>
            {address.city}, {address.regionCode} {address.postalCode}
          </div>
          {address.gstin ? <div className="font-mono text-xs">GSTIN {address.gstin}</div> : null}
        </address>
      </CardContent>
    </Card>
  );
}
