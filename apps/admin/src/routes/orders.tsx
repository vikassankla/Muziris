import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { ShoppingCart } from 'lucide-react';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { EmptyState, NoResults } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { listOrders, ORDER_STEPS, type OrderStep } from '../lib/endpoints.js';
import { formatAmount, formatDateTime } from '../lib/format.js';
import { orderDisplay, STEP_LABELS, STEP_TONES } from '../lib/orders.js';
import { listSearch, type ListSearch } from '../lib/search.js';
import { authedRoute } from './authed.js';

interface OrdersSearch extends ListSearch {
  step?: OrderStep;
}

const ANY = '__any';

export const ordersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders',
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    const step = search['step'];
    return {
      ...listSearch(search),
      ...(ORDER_STEPS.includes(step as OrderStep) ? { step: step as OrderStep } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ after: search.after, limit: search.limit, step: search.step }),
  loader: ({ deps, abortController }) =>
    listOrders(
      {
        after: deps.after,
        step: deps.step,
        ...(deps.limit === undefined ? {} : { limit: deps.limit }),
      },
      abortController.signal,
    ),
  component: OrdersPage,
});

function OrdersPage() {
  const page = ordersRoute.useLoaderData();
  const search = ordersRoute.useSearch();
  const navigate = useNavigate();

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Sales' }, { label: 'Orders' }]} />
      <PageHeader
        title="Orders"
        description="Orders placed by buyer users on every website, newest first. Times are shown in each order's own time zone."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={search.step ?? ANY}
          onValueChange={(value) => {
            void navigate({
              to: '.',
              search: {
                ...(value === ANY ? {} : { step: value as OrderStep }),
                ...(search.limit ? { limit: search.limit } : {}),
              },
            });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-[150px] rounded-full"
            aria-label="Status filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {ORDER_STEPS.map((step) => (
              <SelectItem key={step} value={step}>
                {STEP_LABELS[step]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {search.step ? (
          <Button variant="ghost" size="sm" asChild>
            <Link to="." search={{}}>
              Clear filters
            </Link>
          </Button>
        ) : null}
      </div>
      {page.items.length === 0 && search.after === undefined ? (
        search.step ? (
          <NoResults
            title="No orders match this status"
            description="Choose another status, or clear the filter."
            onClear={() => void navigate({ to: '.', search: {} })}
          />
        ) : (
          <EmptyState
            icon={ShoppingCart}
            title="No orders yet"
            description="Orders appear here as buyer users place them in the storefront."
          />
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead aria-sort="descending">Placed at</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Buyer PO</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {page.items.map((order) => {
                const ctx = orderDisplay(order.currency);
                return (
                  <TableRow key={order.id}>
                    <TableCell>
                      <Link
                        to="/orders/$orderId"
                        params={{ orderId: order.id }}
                        className="font-mono text-[12.5px] font-[550] text-foreground hover:underline"
                      >
                        {order.number}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-[200px] whitespace-normal">
                      {order.customerName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(order.placedAt, ctx)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STEP_TONES[order.step]}>{STEP_LABELS[order.step]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {order.purchaseOrderNumber ?? 'None'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatAmount(order.grandTotal, ctx)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager
            after={search.after}
            nextAfter={page.nextAfter}
            limit={search.limit}
            shown={page.items.length}
            noun="orders"
          />
        </>
      )}
    </Page>
  );
}
