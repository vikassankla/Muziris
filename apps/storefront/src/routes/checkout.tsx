import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { ShoppingCart } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorState } from '../components/states.js';
import { TotalsList } from '../components/totals.js';
import { Alert, AlertTitle } from '../components/ui/alert.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input, Select } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { runOperation } from '../lib/api.js';
import { forgetQuickOrder, quickOrderLines, type CheckoutLine } from '../lib/checkout.js';
import { formatPrice } from '../lib/format.js';
import { signInOn401 } from '../lib/guard.js';
import { formatDay, PAYMENT_METHOD_LABELS, totalRows, type PaymentMethod } from '../lib/orders.js';
import {
  CheckoutAddresses,
  CheckoutPreview,
  PlaceOrder,
  ShoppingList,
  type CheckoutAddressesResult,
  type CheckoutPreviewResult,
} from '../operations/generated.js';
import { authedRoute } from './authed.js';

/** A list holds at most 500 lines, read 50 at a time. */
const MAX_LIST_PAGES = 10;
const MAX_PO_LENGTH = 64;

interface CheckoutSearch {
  list?: string;
}

type Source =
  | { kind: 'list'; id: string; name: string; lines: CheckoutLine[]; leftOut: number }
  | { kind: 'quick'; lines: readonly CheckoutLine[] }
  | { kind: 'none' }
  | { kind: 'list_not_found' };

async function listSource(id: string, signal: AbortSignal): Promise<Source> {
  const lines: CheckoutLine[] = [];
  let leftOut = 0;
  let name = '';
  let after: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { shoppingList }: { shoppingList: { name: string; lines: ListLines } | null } =
      await runOperation(ShoppingList, { id, ...(after === null ? {} : { after }) }, { signal });
    if (!shoppingList) return { kind: 'list_not_found' };
    name = shoppingList.name;
    for (const line of shoppingList.lines.nodes) {
      // A product the buyer may no longer see or order stays on the list but not in the order.
      if (!line.product) {
        leftOut += 1;
        continue;
      }
      lines.push({ productId: line.productId, unitCode: line.unitCode, quantity: line.quantity });
    }
    after = shoppingList.lines.nextAfter;
    if (after === null) break;
  }
  return { kind: 'list', id, name, lines, leftOut };
}

interface ListLines {
  nodes: readonly {
    productId: string;
    unitCode: string;
    quantity: string;
    product: object | null;
  }[];
  nextAfter: string | null;
}

export const checkoutRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/checkout',
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => {
    const list = search['list'];
    return typeof list === 'string' && list.length > 0 && list.length <= 100 ? { list } : {};
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, location, abortController }) => {
    const signal = abortController.signal;
    try {
      const [{ viewer }, source] = await Promise.all([
        runOperation(CheckoutAddresses, {}, { signal }),
        deps.list === undefined
          ? Promise.resolve<Source>(
              quickOrderLines()
                ? { kind: 'quick', lines: quickOrderLines() ?? [] }
                : { kind: 'none' },
            )
          : listSource(deps.list, signal),
      ]);
      return { addresses: viewer.customer.addresses, source };
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  // Quick order lines live in this tab's memory, so the page reads them on every visit.
  staleTime: 0,
  component: CheckoutPage,
});

type Address = CheckoutAddressesResult['viewer']['customer']['addresses'][number];
type Answer = CheckoutPreviewResult['checkoutPreview'];

function CheckoutPage() {
  const { addresses, source } = checkoutRoute.useLoaderData();

  if (source.kind === 'none' || source.kind === 'list_not_found') {
    return (
      <EmptyState
        icon={<ShoppingCart />}
        title={source.kind === 'none' ? 'Nothing to check out' : "We can't find that list"}
        action={
          <div className="flex gap-2">
            <Link to="/quick-order" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Quick order
            </Link>
            <Link
              to="/lists"
              search={{}}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Shopping lists
            </Link>
          </div>
        }
      >
        {source.kind === 'none'
          ? 'Check out from a shopping list or a quick order. Quick order items are kept only until you reload the page.'
          : 'It may have been deleted. You see only the lists your role allows.'}
      </EmptyState>
    );
  }
  if (addresses.length === 0) {
    return (
      <EmptyState icon={<ShoppingCart />} title="Your company has no address yet">
        Ask your account manager to add a billing and a shipping address, then check out again.
      </EmptyState>
    );
  }
  return <CheckoutForm addresses={addresses} source={source} />;
}

function defaultAddress(addresses: readonly Address[], role: 'billing' | 'shipping'): string {
  const preferred = addresses.find((a) =>
    role === 'billing' ? a.isDefaultBilling : a.isDefaultShipping,
  );
  return (preferred ?? addresses[0])?.id ?? '';
}

function addressText(a: Address): string {
  return `${a.label}: ${a.line1}, ${a.city} ${a.postalCode}`;
}

function CheckoutForm({
  addresses,
  source,
}: {
  addresses: readonly Address[];
  source: Extract<Source, { kind: 'list' | 'quick' }>;
}) {
  const { shell } = authedRoute.useRouteContext();
  const { locale } = shell.website;
  const navigate = useNavigate();
  const [billing, setBilling] = useState(() => defaultAddress(addresses, 'billing'));
  const [shipping, setShipping] = useState(() => defaultAddress(addresses, 'shipping'));
  const [po, setPo] = useState('');
  const [method, setMethod] = useState<PaymentMethod | undefined>();
  const [answer, setAnswer] = useState<{ key: string; result?: Answer; error?: unknown }>();
  const [rerun, setRerun] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [placeProblem, setPlaceProblem] = useState<{ message?: string; error?: unknown }>();
  // One key per attempt, sent again on a retry; changed inputs start a new attempt.
  const attempt = useRef<{ inputKey: string; idempotencyKey: string } | undefined>(undefined);

  const trimmedPo = po.trim();
  const input = {
    lines: source.lines.map((l) => ({
      productId: l.productId,
      unitCode: l.unitCode,
      quantity: l.quantity,
    })),
    billingAddressId: billing,
    shippingAddressId: shipping,
    ...(trimmedPo === '' ? {} : { purchaseOrderNumber: trimmedPo }),
  };
  const inputKey = JSON.stringify(input);
  const requestKey = `${inputKey} ${String(rerun)}`;

  // The input object is new on every render; its JSON says when it really changed.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      runOperation(
        CheckoutPreview,
        { input: JSON.parse(inputKey) as typeof input },
        { signal: controller.signal },
      ).then(
        ({ checkoutPreview }) => {
          setAnswer({ key: requestKey, result: checkoutPreview });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setAnswer({ key: requestKey, error });
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [inputKey, requestKey]);

  const current = answer?.key === requestKey ? answer : undefined;
  const preview = current?.result?.preview ?? undefined;
  // The buyer's pick while the preview still offers it, else the first method offered.
  const methods = preview?.paymentMethods ?? [];
  const paymentMethod = method !== undefined && methods.includes(method) ? method : methods[0];
  const refusal = current?.result?.refusal ?? undefined;
  const money = (amount: { amount: string; currency: string }) => formatPrice(amount, locale);

  async function place() {
    if (!preview || paymentMethod === undefined) return;
    const attemptKey = `${inputKey} ${paymentMethod}`;
    if (attempt.current?.inputKey !== attemptKey) {
      attempt.current = { inputKey: attemptKey, idempotencyKey: crypto.randomUUID() };
    }
    setPlacing(true);
    setPlaceProblem(undefined);
    try {
      const { placeOrder } = await runOperation(PlaceOrder, {
        input: {
          ...input,
          idempotencyKey: attempt.current.idempotencyKey,
          expectedGrandTotal: preview.totals.grandTotal.amount,
          paymentMethod,
        },
      });
      if (placeOrder.order) {
        if (source.kind === 'quick') forgetQuickOrder();
        await navigate({
          to: '/orders/$number',
          params: { number: placeOrder.order.number },
          search: source.kind === 'list' ? { fromList: source.id } : {},
        });
        return;
      }
      // Refused: start a new attempt, and show what changed with a fresh preview.
      attempt.current = undefined;
      setPlaceProblem({ message: placeOrder.refusal?.message ?? 'The order was not placed.' });
      setRerun((n) => n + 1);
    } catch (error) {
      // The same key is sent again on a retry, so a lost answer can't place two orders.
      setPlaceProblem({ error });
    } finally {
      setPlacing(false);
    }
  }

  return (
    <>
      <div>
        {source.kind === 'list' ? (
          <Link
            to="/lists/$listId"
            params={{ listId: source.id }}
            search={{}}
            className="text-meta text-muted-foreground"
          >
            {source.name}
          </Link>
        ) : (
          <Link to="/quick-order" className="text-meta text-muted-foreground">
            Quick order
          </Link>
        )}
        <h1 className="m-0 mt-1 text-page-title font-[650] tracking-[-0.015em]">Checkout</h1>
        <p className="m-0 mt-1 text-muted-foreground">Ordering for {shell.viewer.customer.name}.</p>
      </div>
      {source.kind === 'list' && source.leftOut > 0 ? (
        <Alert variant="warning">
          {source.leftOut === 1 ? '1 line is' : `${String(source.leftOut)} lines are`} no longer
          available and left out. They stay on the list.
        </Alert>
      ) : null}
      <div className="grid items-start gap-5 md:grid-cols-[1fr_360px]">
        <Card aria-busy={current === undefined}>
          <CardHeader>
            <CardTitle>Order</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {current?.error ? (
              <ErrorState
                error={current.error}
                onRetry={() => {
                  setRerun((n) => n + 1);
                }}
              />
            ) : refusal ? (
              <Alert variant="warning">
                <AlertTitle>{refusal.message}</AlertTitle>
                {[...refusal.lines, ...refusal.taxProblems].map((p) => (
                  <span key={`${String(p.lineNo)} ${p.code}`}>
                    {p.lineNo === null ? '' : `Line ${String(p.lineNo)}: `}
                    {p.message}
                  </span>
                ))}
              </Alert>
            ) : preview ? (
              <>
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
                    {preview.totals.lines.map((line) => (
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
                <TotalsList rows={totalRows(preview.totals, money)} />
              </>
            ) : (
              <span className="text-meta text-muted-foreground">Working out your totals…</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="billing">Billing address</Label>
              <Select
                id="billing"
                value={billing}
                onChange={(event) => {
                  setBilling(event.target.value);
                }}
              >
                {addresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {addressText(a)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="shipping">Shipping address</Label>
              <Select
                id="shipping"
                value={shipping}
                onChange={(event) => {
                  setShipping(event.target.value);
                }}
              >
                {addresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {addressText(a)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="po">Your PO number (optional)</Label>
              <Input
                id="po"
                maxLength={MAX_PO_LENGTH}
                autoComplete="off"
                value={po}
                onChange={(event) => {
                  setPo(event.target.value);
                }}
              />
            </div>
            {methods.length > 1 ? (
              <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1.5 text-control font-[550]">Pay by</legend>
                {methods.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-control">
                    <input
                      type="radio"
                      name="payment-method"
                      value={m}
                      checked={paymentMethod === m}
                      onChange={() => {
                        setMethod(m);
                      }}
                    />
                    {m === 'TERMS' && preview
                      ? `${PAYMENT_METHOD_LABELS[m]} (${preview.paymentTermDays === 0 ? 'due on receipt' : `net ${String(preview.paymentTermDays)}`})`
                      : PAYMENT_METHOD_LABELS[m]}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {preview && paymentMethod !== 'TERMS' ? (
              <p className="m-0 text-meta text-muted-foreground">
                You pay online right after placing the order. Card and bank details go to the
                payment service, not to us.
              </p>
            ) : preview ? (
              <p className="m-0 text-meta text-muted-foreground">
                {preview.paymentTermDays === 0
                  ? 'Payment is due on receipt'
                  : `Net ${String(preview.paymentTermDays)}: due ${formatDay(preview.dueOn, locale)}`}
                , if you place the order today.
              </p>
            ) : null}
            {placeProblem?.message ? <Alert variant="warning">{placeProblem.message}</Alert> : null}
            {placeProblem?.error ? <ErrorState error={placeProblem.error} /> : null}
            <Button disabled={!preview || placing} onClick={() => void place()}>
              {placing
                ? 'Placing order…'
                : preview
                  ? `Place order · ${money(preview.totals.grandTotal)}`
                  : 'Place order'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
