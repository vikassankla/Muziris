import { CircleAlert, RefreshCw } from 'lucide-react';
import { useEffect, useState, type SubmitEvent } from 'react';
import {
  buildPrices,
  getProduct,
  listCustomers,
  previewPrice,
  searchProducts,
} from '../lib/endpoints.js';
import type {
  Customer,
  PriceBuildState,
  PricePreview,
  Product,
  ProductHit,
} from '../lib/endpoints.js';
import { isApiProblem, type ApiProblem } from '../lib/api.js';
import { formatAmount, formatCount, formatDateTime, type DisplayContext } from '../lib/format.js';
import { useSubmit } from '../lib/use-submit.js';
import { CURRENCY_DISPLAY, useWebsite, useWebsites } from '../lib/website.js';
import { Combobox } from './combobox.js';
import { Field } from './field.js';
import { ProblemAlert } from './problem-view.js';
import { Alert, AlertTitle } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui/sheet.js';

// Pieces the price list screens share (ADR 0022): the build banner, a product picker and the
// price preview.

/** How amounts in a price list's currency show: its own currency, the top bar's time zone. */
export function currencyDisplay(currency: string, website: DisplayContext): DisplayContext {
  return currency === 'INR' || currency === 'USD'
    ? { ...CURRENCY_DISPLAY[currency], timeZone: website.timeZone }
    : website;
}

/** An amount in a currency the admin may not format (only INR and USD are), shown plainly. */
export function formatPrice(amount: string, currency: string, website: DisplayContext): string {
  return currency === 'INR' || currency === 'USD'
    ? formatAmount(amount, currencyDisplay(currency, website))
    : `${amount} ${currency}`;
}

/**
 * "N changes waiting for the price build", with "Build prices now" for a pricing manager.
 * Price changes reach buyers only after a build (ADR 0011).
 */
export function BuildBanner({ build, manage }: { build: PriceBuildState; manage: boolean }) {
  const website = useWebsite();
  const { pending, problem, submit } = useSubmit();
  if (build.pendingChanges === 0) return null;
  const count = build.pendingChanges;
  return (
    <Alert variant="warning" icon={<CircleAlert />}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <AlertTitle>
            {formatCount(count, website)} {count === 1 ? 'change' : 'changes'} waiting for the price
            build
          </AlertTitle>
          <span className="text-meta">
            Buyers see the prices of the last build
            {build.lastBuild ? ` (${formatDateTime(build.lastBuild.builtAt, website)})` : ''}.
          </span>
        </div>
        {manage ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              void submit(buildPrices, { title: 'Prices built' });
            }}
          >
            <RefreshCw aria-hidden="true" />
            Build prices now
          </Button>
        ) : null}
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
    </Alert>
  );
}

/** Finds a product by SKU or name through the admin search, then loads its product units. */
export function ProductPicker({
  id,
  product,
  onProduct,
}: {
  id: string;
  product: Product | undefined;
  onProduct: (product: Product | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchProducts(q, controller.signal)
        .then((found) => {
          setHits(found);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          if (isApiProblem(error)) setProblem(error);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function choose(hit: ProductHit) {
    try {
      onProduct(await getProduct(hit.productId));
      setQuery('');
      setHits([]);
    } catch (error) {
      if (isApiProblem(error)) setProblem(error);
    }
  }

  if (product) {
    return (
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono text-[12.5px]">{product.sku}</span> · {product.name}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onProduct(undefined);
          }}
        >
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        id={id}
        placeholder="Search by SKU or product name"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      {problem ? <ProblemAlert problem={problem} /> : null}
      {query.trim() !== '' && hits.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Matching products"
          className="m-0 flex list-none flex-col p-0"
        >
          {hits.map((hit) => (
            <li key={hit.productId} role="option" aria-selected={false}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => void choose(hit)}
              >
                <span className="font-mono text-[12.5px]">{hit.sku}</span> · {hit.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const STEP_LABELS: Record<string, { label: string; tone: 'success' | 'neutral' | 'info' }> = {
  used: { label: 'Used', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  not_reached: { label: 'Not reached', tone: 'info' },
  inactive: { label: 'Inactive', tone: 'neutral' },
};

const TARGET_LABELS: Record<string, string> = {
  customer: 'Customer',
  customer_group: 'Customer group',
  website: 'Website',
};

const REASONS: Record<string, string> = {
  no_price: 'No price list in the chain prices this product in this unit.',
  needs_rebuild:
    'The customer changed customer group since the last build. Build prices to price it.',
  customer_not_found: 'No such customer.',
};

/**
 * The price a customer gets for a quantity of a product on a website, and the chain step by step
 * (PriceListDetail board). Opened from both price list screens.
 */
export function PricePreviewSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const website = useWebsite();
  const websites = useWebsites();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [websiteId, setWebsiteId] = useState(website.id);
  const [product, setProduct] = useState<Product | undefined>();
  const [unitCode, setUnitCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [preview, setPreview] = useState<PricePreview | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listCustomers({ limit: 100 }, controller.signal)
      .then((page) => {
        setCustomers(page.items);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [open]);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerId || !product) return;
    setPending(true);
    setProblem(undefined);
    try {
      setPreview(
        await previewPrice({
          customerId,
          websiteId,
          productId: product.id,
          unitCode: unitCode || product.primaryUnitCode,
          quantity,
        }),
      );
    } catch (error) {
      setPreview(undefined);
      if (isApiProblem(error)) setProblem(error);
    } finally {
      setPending(false);
    }
  }

  const unit = product?.units.find((u) => u.code === (unitCode || product.primaryUnitCode));
  const money = (amount: string) => formatPrice(amount, preview?.currency ?? '', website);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Price preview</SheetTitle>
          <SheetDescription>
            What a buyer of this customer pays on this website, and where the price comes from.
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            <Field label="Customer" hint="The first 100 customers, by name.">
              {({ id }) => (
                <Combobox
                  id={id}
                  value={customerId}
                  onChange={setCustomerId}
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Choose a customer"
                  searchLabel="Search customers"
                />
              )}
            </Field>
            <Field label="Website">
              {({ id }) => (
                <Select value={websiteId} onValueChange={setWebsiteId}>
                  <SelectTrigger id={id}>
                    <SelectValue placeholder="Choose a website" />
                  </SelectTrigger>
                  <SelectContent>
                    {websites.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Product">
              {({ id }) => (
                <ProductPicker
                  id={id}
                  product={product}
                  onProduct={(p) => {
                    setProduct(p);
                    setUnitCode(p?.primaryUnitCode ?? '');
                  }}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Quantity">
                {(props) => (
                  <Input
                    {...props}
                    required
                    inputMode="decimal"
                    className="num"
                    value={quantity}
                    onChange={(e) => {
                      setQuantity(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Product unit">
                {({ id }) => (
                  <Select
                    value={unitCode}
                    onValueChange={setUnitCode}
                    disabled={product === undefined}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue placeholder="Choose a product first" />
                    </SelectTrigger>
                    <SelectContent>
                      {(product?.units ?? []).map((u) => (
                        <SelectItem key={u.code} value={u.code}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
            {problem ? <ProblemAlert problem={problem} /> : null}
            {preview ? (
              <section aria-label="Preview result" className="flex flex-col gap-3">
                {preview.price && preview.lineAmount ? (
                  <div className="flex flex-col gap-0.5 rounded-md border border-border p-3">
                    <span className="text-meta text-muted-foreground">Final unit price</span>
                    <span className="num text-xl font-[650]">{money(preview.price.unitPrice)}</span>
                    <span className="num text-meta text-muted-foreground">
                      {preview.quantity} {unit?.name ?? ''} × {money(preview.price.unitPrice)} ={' '}
                      <span className="text-foreground">{money(preview.lineAmount)}</span> before
                      tax
                    </span>
                  </div>
                ) : (
                  <Alert variant="warning">
                    {REASONS[preview.reason ?? ''] ?? 'No price.'} Buyers see “Price on request”.
                  </Alert>
                )}
                {preview.unbuiltPrice &&
                preview.unbuiltPrice.unitPrice !== preview.price?.unitPrice ? (
                  <Alert variant="info">
                    After the next build: {money(preview.unbuiltPrice.unitPrice)}.
                  </Alert>
                ) : null}
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {preview.steps.map((step) => {
                    const shown = STEP_LABELS[step.status] ?? {
                      label: step.status,
                      tone: 'neutral' as const,
                    };
                    return (
                      <li
                        key={`${step.priceListId}-${step.target}`}
                        className="flex items-start gap-2"
                      >
                        <Badge variant={shown.tone}>{shown.label}</Badge>
                        <span className="text-meta">
                          <span className="font-semibold">{TARGET_LABELS[step.target]}</span> ·{' '}
                          {step.priceListName}
                          {step.tier
                            ? `, ${money(step.tier.unitPrice)} from ${step.tier.minQuantity}`
                            : ''}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Close</Button>
            </SheetClose>
            <Button type="submit" disabled={pending || !customerId || !product}>
              Preview price
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
