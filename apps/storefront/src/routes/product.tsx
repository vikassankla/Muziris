import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { ShoppingCart } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { ListPicker } from '../components/list-picker.js';
import { PRICE_ON_REQUEST } from '../components/product-list.js';
import { ErrorState, ProductNotFound } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
import { Tag } from '../components/ui/badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input, Select } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { isApiProblem, runOperation, type ApiProblem } from '../lib/api.js';
import { handToCheckout, type CheckoutLine } from '../lib/checkout.js';
import { checkQuantity, formatPrice, lineTotal } from '../lib/format.js';
import { signInOn401 } from '../lib/guard.js';
import { addToShoppingList, NEW_LIST } from '../lib/shopping-lists.js';
import {
  Product,
  ProductPrice,
  ShoppingLists,
  type ProductResult,
  type ShoppingListsResult,
} from '../operations/generated.js';
import { authedRoute } from './authed.js';

type FoundProduct = NonNullable<ProductResult['product']>;
type Price = FoundProduct['price'];
/** The buyer's lists to add to; null while shopping lists are off (ADR 0031). */
type Lists = ShoppingListsResult['shoppingLists']['nodes'] | null;

export const productRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/p/$sku',
  loader: async ({ context, params, location, abortController }) => {
    const signal = abortController.signal;
    try {
      // The lists to add to: the 50 most recently changed are enough to pick from. With shopping
      // lists off there is nothing to add to, and the API would refuse.
      const [{ product }, lists] = await Promise.all([
        runOperation(Product, { sku: params.sku }, { signal }),
        context.shell.features.shoppingLists
          ? runOperation(ShoppingLists, { first: 50 }, { signal }).then(
              (r) => r.shoppingLists.nodes,
            )
          : null,
      ]);
      return { product, lists };
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: ProductPage,
});

function ProductPage() {
  const { product, lists } = productRoute.useLoaderData();
  const { tree } = authedRoute.useRouteContext();

  if (!product) {
    return (
      <ProductNotFound
        action={
          <Link
            to="/search"
            search={{ q: '' }}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Search products
          </Link>
        }
      />
    );
  }
  const path = product.category ? tree.path(product.category.id) : [];

  return (
    <>
      <nav
        className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground"
        aria-label="Breadcrumb"
      >
        <Link to="/" className="text-inherit no-underline hover:text-foreground hover:underline">
          All products
        </Link>
        {path.map((c) => (
          <Fragment key={c.id}>
            <span aria-hidden="true">/</span>
            <Link
              to="/c/$categoryId"
              params={{ categoryId: c.id }}
              className="text-inherit no-underline hover:text-foreground hover:underline"
            >
              {c.name}
            </Link>
          </Fragment>
        ))}
        <span aria-hidden="true">/</span>
        <span aria-current="page" className="font-mono text-foreground">
          {product.sku}
        </span>
      </nav>
      <div className="flex flex-wrap items-start gap-6">
        <section
          className="flex min-w-0 flex-[999_1_520px] flex-col gap-4"
          aria-labelledby="product-title"
        >
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[12.5px] text-muted-foreground">{product.sku}</span>
            <h1
              id="product-title"
              className="m-0 text-[26px] leading-tight font-[650] tracking-[-0.015em]"
            >
              {product.name}
            </h1>
            {product.category ? (
              <span className="text-meta text-muted-foreground">
                in{' '}
                <Link
                  to="/c/$categoryId"
                  params={{ categoryId: product.category.id }}
                  className="text-primary underline underline-offset-2"
                >
                  {product.category.name}
                </Link>
              </span>
            ) : null}
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="m-0 grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-control">
                {product.attributes.map((attribute) => (
                  <Fragment key={attribute.key}>
                    <dt className="text-muted-foreground">{attribute.key}</dt>
                    <dd className="m-0">{attribute.values.join(', ')}</dd>
                  </Fragment>
                ))}
                <dt className="text-muted-foreground">Sold in</dt>
                <dd className="m-0">
                  {product.units
                    .map((unit) =>
                      unit.code === product.primaryUnit.code ? `${unit.name} (primary)` : unit.name,
                    )
                    .join(', ')}
                </dd>
              </dl>
            </CardContent>
          </Card>
        </section>
        <PriceBox product={product} lists={lists} />
      </div>
    </>
  );
}

/** The API's answer for one unit and quantity, kept with the request it answers. */
type Answer =
  | { key: string; state: 'priced'; price: Price }
  | { key: string; state: 'refused'; problem: ApiProblem }
  | { key: string; state: 'failed'; problem: unknown };

/**
 * "Your price" (ProductDetail board): pick a unit and a quantity, and the price is asked for
 * once the quantity fits the unit. The quantity is checked here first; a BAD_USER_INPUT from the
 * API is shown under the field too. One of the primary unit is the price the page loaded with.
 */
function PriceBox({ product, lists }: { product: FoundProduct; lists: Lists }) {
  const { shell } = authedRoute.useRouteContext();
  const locale = shell.website.locale;
  const [unitCode, setUnitCode] = useState(product.primaryUnit.code);
  const [text, setText] = useState('1');
  const [answer, setAnswer] = useState<Answer | undefined>();
  const unit = product.units.find((u) => u.code === unitCode) ?? product.primaryUnit;
  const check = checkQuantity(text, unit);
  const quantity = check.ok ? check.quantity : undefined;
  const key = quantity === undefined ? undefined : `${unitCode} ${quantity}`;
  const loaded = unitCode === product.primaryUnit.code && quantity === '1';

  useEffect(() => {
    if (quantity === undefined || loaded) return undefined;
    const requestKey = `${unitCode} ${quantity}`;
    const controller = new AbortController();
    // Wait for the buyer to stop typing; a newer quantity cancels this request.
    const timer = setTimeout(() => {
      runOperation(
        ProductPrice,
        { sku: product.sku, unitCode, quantity },
        { signal: controller.signal },
      ).then(
        (data) => {
          setAnswer({ key: requestKey, state: 'priced', price: data.product?.price ?? null });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setAnswer(
            isApiProblem(error) && error.code === 'BAD_USER_INPUT'
              ? { key: requestKey, state: 'refused', problem: error }
              : { key: requestKey, state: 'failed', problem: error },
          );
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [product.sku, unitCode, quantity, loaded]);

  const current: Answer | undefined = loaded
    ? { key: key ?? '', state: 'priced', price: product.price }
    : answer?.key === key
      ? answer
      : undefined;
  const loading = check.ok && current === undefined;
  const fieldError = check.ok
    ? current?.state === 'refused'
      ? current.problem.title
      : undefined
    : check.message;
  const price = current?.state === 'priced' ? current.price : null;
  const quote = current ?? { state: 'loading' as const };

  return (
    <Card
      className="w-full shadow-overlay md:max-w-[420px] md:flex-[1_1_340px]"
      aria-labelledby="price-title"
      aria-busy={loading}
    >
      <CardHeader>
        <CardTitle id="price-title">Your price</CardTitle>
        <span className="flex-1" />
        <Tag>{shell.viewer.customer.name}</Tag>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {product.units.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unit">Unit</Label>
            <Select
              id="unit"
              className="h-11 md:h-control"
              value={unitCode}
              onChange={(event) => {
                setUnitCode(event.target.value);
                setText('1');
              }}
            >
              {product.units.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quantity">Quantity</Label>
          <Input
            id="quantity"
            className="num h-11 md:h-control"
            inputMode={unit.precision === 0 ? 'numeric' : 'decimal'}
            autoComplete="off"
            value={text}
            aria-invalid={fieldError !== undefined}
            aria-describedby="quantity-hint"
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          {fieldError !== undefined ? (
            <span id="quantity-hint" role="alert" className="text-meta text-destructive-text">
              {fieldError}
            </span>
          ) : (
            <span id="quantity-hint" className="text-meta text-muted-foreground">
              {unit.precision === 0
                ? `Whole ${unit.name.toLowerCase()} only.`
                : `Up to ${unit.precision} decimals.`}
            </span>
          )}
        </div>
        {quote.state === 'failed' ? (
          <ErrorState error={quote.problem} />
        ) : fieldError !== undefined ? null : price ? (
          <>
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-1.5">
                <span className="num text-[28px] font-[650] tracking-[-0.02em]">
                  {formatPrice(price.unitPrice, locale)}
                </span>
                <span className="text-meta text-muted-foreground">
                  per {unit.name.toLowerCase()}
                </span>
              </div>
              {price.minQuantity !== '1' ? (
                <span className="text-meta text-muted-foreground">
                  Price for {price.minQuantity} or more.
                </span>
              ) : null}
            </div>
            {quantity !== undefined && quantity !== '1' ? (
              <>
                <hr className="m-0 h-px border-0 bg-border" />
                <div className="flex items-center">
                  <span className="text-muted-foreground">
                    {quantity} × {formatPrice(price.unitPrice, locale)}
                  </span>
                  <span className="flex-1" />
                  <span className="num text-[15px] font-[650]">
                    {formatPrice(
                      {
                        amount: lineTotal(price.unitPrice, quantity),
                        currency: price.unitPrice.currency,
                      },
                      locale,
                    )}
                  </span>
                </div>
              </>
            ) : null}
          </>
        ) : quote.state === 'priced' ? (
          <Alert variant="warning">
            <span>
              <span className="font-semibold">{PRICE_ON_REQUEST}.</span> There is no price for this
              unit and quantity on your account yet. Contact your account manager for a quote.
            </span>
          </Alert>
        ) : (
          <span className="text-meta text-muted-foreground">Checking your price…</span>
        )}
        <LineActions
          line={
            quantity === undefined || fieldError !== undefined
              ? undefined
              : { productId: product.id, unitCode, quantity }
          }
          priced={price !== null}
          lists={lists}
        />
        <p className="m-0 text-xs text-muted-foreground">
          {shell.website.currency}, excluding GST. Quantity breaks apply per order line.
        </p>
      </CardContent>
    </Card>
  );
}

type Outcome =
  | { kind: 'added'; listId: string; listName: string }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; error: unknown };

function sameLine(a: CheckoutLine, b: CheckoutLine): boolean {
  return a.productId === b.productId && a.unitCode === b.unitCode && a.quantity === b.quantity;
}

/**
 * What a buyer does with the unit and quantity in the price box: order it now (checkout gets
 * the one line in memory, as from quick order) or add it to a shopping list. Ordering needs a
 * price; a list takes the line either way. A message about one line goes away when the buyer
 * changes the unit or quantity.
 */
function LineActions({
  line,
  priced,
  lists,
}: {
  line: CheckoutLine | undefined;
  priced: boolean;
  lists: Lists;
}) {
  const navigate = useNavigate();
  const [target, setTarget] = useState(lists?.[0]?.id ?? NEW_LIST);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ line: CheckoutLine; outcome: Outcome }>();
  const outcome = result && line && sameLine(result.line, line) ? result.outcome : undefined;

  function orderNow() {
    if (!line) return;
    handToCheckout([line]);
    void navigate({ to: '/checkout', search: {} });
  }

  async function addToList() {
    if (!line) return;
    setBusy(true);
    setResult(undefined);
    try {
      const added = await addToShoppingList(target, newName, [line]);
      setResult({
        line,
        outcome: added.ok
          ? { kind: 'added', listId: added.listId, listName: added.listName }
          : { kind: 'refused', message: added.message },
      });
    } catch (error) {
      setResult({ line, outcome: { kind: 'failed', error } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <Button className="h-11 md:h-control" disabled={!line || !priced || busy} onClick={orderNow}>
        <ShoppingCart aria-hidden="true" />
        Order now
      </Button>
      {lists ? (
        <>
          <ListPicker
            lists={lists}
            target={target}
            onTarget={setTarget}
            newName={newName}
            onNewName={setNewName}
          />
          <Button
            variant="outline"
            className="h-11 md:h-control"
            disabled={!line || busy || (target === NEW_LIST && newName.trim() === '')}
            onClick={() => void addToList()}
          >
            Add to shopping list
          </Button>
        </>
      ) : null}
      {outcome?.kind === 'added' ? (
        <Alert variant="info" role="status">
          <span>
            Added to {outcome.listName}.{' '}
            <Link
              to="/lists/$listId"
              params={{ listId: outcome.listId }}
              search={{}}
              className="font-semibold text-inherit underline underline-offset-2"
            >
              View list
            </Link>
          </span>
        </Alert>
      ) : outcome?.kind === 'refused' ? (
        <Alert variant="destructive" role="alert">
          <span>{outcome.message}</span>
        </Alert>
      ) : outcome?.kind === 'failed' ? (
        <ErrorState error={outcome.error} />
      ) : null}
    </div>
  );
}
