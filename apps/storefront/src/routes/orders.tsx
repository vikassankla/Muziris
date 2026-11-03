import { createRoute, Link } from '@tanstack/react-router';
import { ClipboardList, PackageX } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState } from '../components/states.js';
import { PaymentPanel } from '../components/payment-panel.js';
import { TotalsList } from '../components/totals.js';
import { Alert } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
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
import { formatDateTime, formatDay, STEP_LABELS, STEP_TONES, totalRows } from '../lib/orders.js';
import { regionLabel } from '../lib/regions.js';
import {
  Order,
  Orders,
  RemoveShoppingListLines,
  ShoppingList,
  type OrderResult,
  type ShoppingListResult,
} from '../operations/generated.js';
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

interface OrderSearch {
  /** The shopping list the order was just placed from, to offer emptying it. */
  fromList?: string;
}

export const orderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders/$number',
  validateSearch: (search: Record<string, unknown>): OrderSearch => {
    const fromList = search['fromList'];
    return typeof fromList === 'string' && fromList.length > 0 && fromList.length <= 100
      ? { fromList }
      : {};
  },
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
  const { fromList } = orderRoute.useSearch();
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
  const totals = totalRows(order, money);

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
      {fromList === undefined ? null : <EmptyListOffer listId={fromList} />}
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
          <TotalsList rows={totals} />
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
            {order.paymentMethod !== 'TERMS' ? (
              <div className="mb-3">
                <PaymentPanel
                  key={order.payment?.status ?? 'PENDING'}
                  orderNumber={order.number}
                  method={order.paymentMethod}
                  initialStatus={order.payment?.status ?? 'PENDING'}
                  total={order.grandTotal}
                  locale={locale}
                  shopName={shell.website.name}
                />
              </div>
            ) : null}
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta">
              {order.dueOn ? (
                <>
                  <dt className="text-muted-foreground">Terms</dt>
                  <dd className="m-0">
                    {order.paymentTermDays === 0
                      ? 'Due on receipt'
                      : `Net ${String(order.paymentTermDays)}`}
                  </dd>
                  <dt className="text-muted-foreground">Due</dt>
                  <dd className="m-0">{formatDay(order.dueOn, locale)}</dd>
                </>
              ) : null}
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
            {address.city}, {regionLabel(address.countryCode, address.regionCode)}{' '}
            {address.postalCode}
          </div>
          {address.gstin ? <div className="font-mono text-xs">GSTIN {address.gstin}</div> : null}
        </address>
      </CardContent>
    </Card>
  );
}

/**
 * After checkout from a list (ADR 0018): the list stays as it was, because buyers reorder from
 * the same list, and the buyer may empty it here.
 */
function EmptyListOffer({ listId }: { listId: string }) {
  const [state, setState] = useState<'offered' | 'emptying' | 'emptied' | 'refused'>('offered');
  const [problem, setProblem] = useState<{ message?: string; error?: unknown }>();

  async function empty() {
    setState('emptying');
    setProblem(undefined);
    try {
      const lineIds: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const { shoppingList }: ShoppingListResult = await runOperation(ShoppingList, {
          id: listId,
          ...(after === null ? {} : { after }),
        });
        if (!shoppingList) break;
        lineIds.push(...shoppingList.lines.nodes.map((l) => l.id));
        after = shoppingList.lines.nextAfter;
        if (after === null) break;
      }
      if (lineIds.length > 0) {
        const { removeShoppingListLines } = await runOperation(RemoveShoppingListLines, {
          listId,
          lineIds,
        });
        if (removeShoppingListLines.refusal) {
          setState('refused');
          setProblem({ message: removeShoppingListLines.refusal.message });
          return;
        }
      }
      setState('emptied');
    } catch (error) {
      setState('refused');
      setProblem({ error });
    }
  }

  if (state === 'emptied') return <Alert variant="info">The shopping list is empty now.</Alert>;
  return (
    <Alert variant="info">
      <span>Order placed. The shopping list you ordered from is unchanged.</span>
      {problem?.message ? <span>{problem.message}</span> : null}
      {problem?.error ? <ErrorState error={problem.error} /> : null}
      <div className="mt-1.5 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={state === 'emptying'}
          onClick={() => void empty()}
        >
          Empty the list
        </Button>
        <Link
          to="/lists/$listId"
          params={{ listId }}
          search={{}}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          Open the list
        </Link>
      </div>
    </Alert>
  );
}
