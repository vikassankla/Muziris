import { createRoute, Link } from '@tanstack/react-router';
import { Fragment, useEffect, useState } from 'react';
import { PRICE_ON_REQUEST } from '../components/product-list.js';
import { ErrorState, ProductNotFound } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
import { Tag } from '../components/ui/badge.js';
import { buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input, Select } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { isApiProblem, runOperation, type ApiProblem } from '../lib/api.js';
import { checkQuantity, formatPrice, lineTotal } from '../lib/format.js';
import { signInOn401 } from '../lib/guard.js';
import { Product, ProductPrice, type ProductResult } from '../operations/generated.js';
import { authedRoute } from './authed.js';

type FoundProduct = NonNullable<ProductResult['product']>;
type Price = FoundProduct['price'];

export const productRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/p/$sku',
  loader: async ({ params, location, abortController }) => {
    try {
      return await runOperation(Product, { sku: params.sku }, { signal: abortController.signal });
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: ProductPage,
});

function ProductPage() {
  const { product } = productRoute.useLoaderData();
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
        <PriceBox product={product} />
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
function PriceBox({ product }: { product: FoundProduct }) {
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
        <p className="m-0 text-xs text-muted-foreground">
          {shell.website.currency}, excluding GST. Quantity breaks apply per order line.
        </p>
      </CardContent>
    </Card>
  );
}
