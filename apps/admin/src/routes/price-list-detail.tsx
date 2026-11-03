import { createRoute, useNavigate } from '@tanstack/react-router';
import { Calculator, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import {
  BuildBanner,
  currencyDisplay,
  formatPrice,
  PricePreviewSheet,
  ProductPicker,
} from '../components/pricing.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Alert, AlertTitle } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../components/ui/sheet.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { TabCount, Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Combobox } from '../components/combobox.js';
import type { ApiProblem, ImportRowProblem } from '../lib/api.js';
import {
  addPrice,
  allCustomerGroups,
  ASSIGNMENT_TARGETS,
  createAssignment,
  deleteAssignment,
  deletePrice,
  deletePriceList,
  getPriceBuild,
  getPriceList,
  importPrices,
  listAssignments,
  listCustomers,
  listPrices,
  pricesCsvUrl,
  updateAssignment,
  updatePrice,
  updatePriceList,
  type Assignment,
  type AssignmentTarget,
  type Price,
  type PriceImportResult,
  type PriceList,
  type Product,
} from '../lib/endpoints.js';
import { formatCount } from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { activeDates, dayOf, dayStart } from '../lib/price-dates.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite, useWebsites } from '../lib/website.js';
import { authedRoute } from './authed.js';
import { STATUS_LABELS, STATUS_TONES } from './price-lists.js';

// One price list (ADR 0022, PriceListDetail board): its prices with their tiers, CSV import and
// export, and its assignments.

const TABS = ['prices', 'assignments'] as const;
type Tab = (typeof TABS)[number];

interface DetailSearch {
  tab?: Tab;
  q?: string;
  unit?: string;
  after?: string;
  limit?: number;
}

const ANY = '__any';

const TARGET_LABELS: Record<AssignmentTarget, string> = {
  customer: 'Customer',
  customer_group: 'Customer group',
  website: 'Website',
};

/** Why an import row was refused, in words (codes from ADR 0022). */
const ROW_CODES: Record<string, string> = {
  unknown_sku: 'no product has this SKU',
  unit_not_sold: 'the product is not sold in this product unit',
  invalid_quantity: 'the minimum quantity is not valid',
  invalid_amount: 'the price is not valid',
  duplicate_row: 'an earlier row has the same SKU, unit and minimum quantity',
};

function detailSearch(search: Record<string, unknown>): DetailSearch {
  const out: DetailSearch = {};
  const text = (key: string) => {
    const value = search[key];
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 100
      ? value
      : undefined;
  };
  const tab = search['tab'];
  if (typeof tab === 'string' && (TABS as readonly string[]).includes(tab)) out.tab = tab as Tab;
  const q = text('q');
  if (q !== undefined) out.q = q;
  const unit = text('unit');
  if (unit !== undefined) out.unit = unit;
  const after = text('after');
  if (after !== undefined) out.after = after;
  const limit = Number(search['limit']);
  if ([25, 50, 100].includes(limit)) out.limit = limit;
  return out;
}

export const priceListDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/price-lists/$priceListId',
  validateSearch: detailSearch,
  loaderDeps: ({ search }) => ({
    q: search.q,
    unit: search.unit,
    after: search.after,
    limit: search.limit,
  }),
  loader: async ({ params, deps, abortController }) => {
    const signal = abortController.signal;
    const [priceList, prices, assignments, build] = await Promise.all([
      getPriceList(params.priceListId, signal),
      listPrices(
        params.priceListId,
        { q: deps.q, unitCode: deps.unit, after: deps.after, limit: deps.limit },
        signal,
      ),
      listAssignments({ priceListId: params.priceListId }, signal),
      getPriceBuild(signal),
    ]);
    return { priceList, prices, assignments, build };
  },
  component: PriceListDetailPage,
});

/** A CSV of the skipped rows, for "Download skipped rows". */
function skippedCsv(rows: readonly ImportRowProblem[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return (
    [
      'row,sku,code,message',
      ...rows.map((r) => [String(r.row), r.sku, r.code, r.message].map(cell).join(',')),
    ].join('\r\n') + '\r\n'
  );
}

function rowsSummary(rows: readonly ImportRowProblem[]): string {
  const byCode = new Map<string, number[]>();
  for (const r of rows) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r.row]);
  return [...byCode]
    .map(([code, numbers]) => {
      const shown = numbers.slice(0, 5).join(', ');
      const more = numbers.length > 5 ? ` and ${String(numbers.length - 5)} more` : '';
      return `Row${numbers.length === 1 ? '' : 's'} ${shown}${more}: ${ROW_CODES[code] ?? code}.`;
    })
    .join(' ');
}

function ImportDialog({
  priceList,
  open,
  onOpenChange,
  onImported,
}: {
  priceList: PriceList;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (result: PriceImportResult) => void;
}) {
  const [csv, setCsv] = useState<string | undefined>();
  const [fileName, setFileName] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const refusedRows: readonly ImportRowProblem[] =
    problem?.code === 'price_import_invalid_rows' ? problem.rows : [];

  async function run(skipInvalid: boolean) {
    if (csv === undefined) return;
    const result = await submit(() => importPrices(priceList.id, csv, skipInvalid));
    if (result) {
      onImported(result);
      onOpenChange(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import prices</DialogTitle>
          <DialogDescription>
            A CSV with the columns sku, unit, min_quantity and price, in {priceList.currency}, at
            most 10,000 rows. A row adds or replaces the price for its product, unit and minimum
            quantity; prices not in the file stay.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            void run(false);
          }}
        >
          <Field label="CSV file" hint={fileName || 'Export this list for a file to start from.'}>
            {(props) => (
              <Input
                {...props}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setProblem(undefined);
                  setFileName(file?.name ?? '');
                  if (!file) {
                    setCsv(undefined);
                    return;
                  }
                  void file.text().then(setCsv);
                }}
              />
            )}
          </Field>
          {problem && refusedRows.length === 0 ? <ProblemAlert problem={problem} /> : null}
          {refusedRows.length > 0 ? (
            <Alert variant="warning">
              <AlertTitle>
                {formatCount(refusedRows.length, {
                  locale: 'en-IN',
                  currency: 'INR',
                  timeZone: 'UTC',
                })}{' '}
                {refusedRows.length === 1 ? 'row is' : 'rows are'} not valid, so nothing was
                imported.
              </AlertTitle>
              <span className="text-meta">{rowsSummary(refusedRows)}</span>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            {refusedRows.length > 0 ? (
              <Button disabled={pending} onClick={() => void run(true)}>
                Import the valid rows
              </Button>
            ) : (
              <Button type="submit" disabled={pending || csv === undefined}>
                Import
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddPriceDialog({
  priceList,
  open,
  onOpenChange,
}: {
  priceList: PriceList;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [product, setProduct] = useState<Product | undefined>();
  const [unitCode, setUnitCode] = useState('');
  const [minQuantity, setMinQuantity] = useState('1');
  const [amount, setAmount] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!product) return;
    const added = await submit(
      () => addPrice(priceList.id, { productId: product.id, unitCode, minQuantity, amount }),
      { title: 'Price added', description: product.sku },
    );
    if (added) {
      setProduct(undefined);
      setAmount('');
      setMinQuantity('1');
      onOpenChange(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add price</DialogTitle>
          <DialogDescription>
            A price for a product in one unit, from a minimum quantity. Add more for tiers.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field label="Product" error={errors['productId']}>
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
          <div className="grid grid-cols-3 gap-4">
            <Field label="Product unit">
              {({ id }) => (
                <Select value={unitCode} onValueChange={setUnitCode} disabled={!product}>
                  <SelectTrigger id={id}>
                    <SelectValue placeholder="Unit" />
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
            <Field label="Minimum quantity" error={errors['minQuantity']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  inputMode="decimal"
                  className="num"
                  value={minQuantity}
                  onChange={(e) => {
                    setMinQuantity(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={`Price (${priceList.currency})`} error={errors['amount']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  inputMode="decimal"
                  className="num"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !product}>
              Add price
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditPriceDialog({ price, onClose }: { price: Price; onClose: () => void }) {
  const [amount, setAmount] = useState(price.amount);
  const { pending, problem, submit } = useSubmit();
  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await submit(() => updatePrice(price.id, amount), {
      title: 'Price saved',
      ...(price.sku ? { description: price.sku } : {}),
    });
    if (saved) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {price.sku ?? 'Price'}, {price.unitCode} from {price.minQuantity}
          </DialogTitle>
          <DialogDescription>{price.productName}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem ? <ProblemAlert problem={problem} /> : null}
          <Field label={`Price (${price.currency})`}>
            {(props) => (
              <Input
                {...props}
                required
                inputMode="decimal"
                className="num"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Save price
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditListSheet({ priceList, onClose }: { priceList: PriceList; onClose: () => void }) {
  const website = useWebsite();
  const [name, setName] = useState(priceList.name);
  const [from, setFrom] = useState(
    priceList.activeFrom ? dayOf(priceList.activeFrom, website.timeZone) : '',
  );
  const [until, setUntil] = useState(
    priceList.activeUntil ? dayOf(priceList.activeUntil, website.timeZone, -1) : '',
  );
  const { pending, problem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await submit(
      () =>
        updatePriceList(priceList.id, {
          name,
          activeFrom: from ? dayStart(from, website.timeZone) : null,
          activeUntil: until ? dayStart(until, website.timeZone, 1) : null,
        }),
      { title: 'Price list saved', description: name },
    );
    if (saved) onClose();
  }
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Rename and dates</SheetTitle>
          <SheetDescription>The currency, {priceList.currency}, cannot change.</SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            {problem && problem.code !== 'validation_failed' ? (
              <ProblemAlert problem={problem} />
            ) : null}
            <Field label="Name" error={errors['name']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Active from" optional>
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Active until" optional hint="Through the end of this day.">
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={until}
                    onChange={(e) => {
                      setUntil(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function AddAssignmentDialog({
  priceList,
  open,
  onOpenChange,
}: {
  priceList: PriceList;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const websites = useWebsites().filter((w) => w.defaultCurrency === priceList.currency);
  const [websiteId, setWebsiteId] = useState(websites[0]?.id ?? '');
  const [target, setTarget] = useState<AssignmentTarget>('customer_group');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [priority, setPriority] = useState('');
  const [options, setOptions] = useState<{ value: string; label: string }[] | undefined>();
  const [loadProblem, setLoadProblem] = useState<ApiProblem | undefined>();
  const { pending, problem, setProblem, submit } = useSubmit();

  async function chooseTarget(next: AssignmentTarget) {
    setTarget(next);
    setTargetId(null);
    setOptions(undefined);
    if (next === 'website') return;
    try {
      setOptions(
        next === 'customer'
          ? (await listCustomers({ limit: 200 })).items.map((c) => ({ value: c.id, label: c.name }))
          : (await allCustomerGroups()).map((g) => ({ value: g.id, label: g.name })),
      );
    } catch (error) {
      setLoadProblem(error as ApiProblem);
    }
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await submit(
      () =>
        createAssignment({
          priceListId: priceList.id,
          websiteId,
          target,
          ...(target === 'website' || targetId === null ? {} : { targetId }),
          ...(priority === '' ? {} : { priority: Number(priority) }),
        }),
      { title: 'Price list assigned' },
    );
    if (created) onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && options === undefined && target !== 'website') void chooseTarget(target);
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign price list</DialogTitle>
          <DialogDescription>
            Only websites in {priceList.currency} can use this price list. Within a target, the
            lowest priority is tried first.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem ? <ProblemAlert problem={problem} /> : null}
          {loadProblem ? <ProblemAlert problem={loadProblem} /> : null}
          {websites.length === 0 ? (
            <Alert variant="warning">No website sells in {priceList.currency}.</Alert>
          ) : null}
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
          <Field label="Assign to">
            {({ id }) => (
              <Select
                value={target}
                onValueChange={(next) => void chooseTarget(next as AssignmentTarget)}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNMENT_TARGETS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t === 'website' ? 'The whole website' : TARGET_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          {target === 'website' ? null : (
            <Field label={TARGET_LABELS[target]}>
              {({ id }) => (
                <Combobox
                  id={id}
                  value={targetId}
                  onChange={setTargetId}
                  options={options ?? []}
                  placeholder={`Choose a ${TARGET_LABELS[target].toLowerCase()}`}
                  searchLabel={`Search ${target === 'customer' ? 'customers' : 'customer groups'}`}
                />
              )}
            </Field>
          )}
          <Field label="Priority" optional hint="Left empty, it comes after the target’s others.">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={1000}
                className="num w-28"
                value={priority}
                onChange={(e) => {
                  setPriority(e.target.value);
                }}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || websiteId === '' || (target !== 'website' && targetId === null)}
            >
              Assign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PriorityDialog({ assignment, onClose }: { assignment: Assignment; onClose: () => void }) {
  const [priority, setPriority] = useState(String(assignment.priority));
  const { pending, problem, submit } = useSubmit();
  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await submit(() => updateAssignment(assignment.id, Number(priority)), {
      title: 'Priority saved',
    });
    if (saved) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change priority</DialogTitle>
          <DialogDescription>
            {assignment.targetName ?? assignment.targetId} on{' '}
            {assignment.websiteName ?? 'its website'}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem ? <ProblemAlert problem={problem} /> : null}
          <Field label="Priority">
            {(props) => (
              <Input
                {...props}
                type="number"
                required
                min={1}
                max={1000}
                className="num w-28"
                value={priority}
                onChange={(e) => {
                  setPriority(e.target.value);
                }}
              />
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Open =
  | { kind: 'import' }
  | { kind: 'add' }
  | { kind: 'edit_list' }
  | { kind: 'delete_list' }
  | { kind: 'preview' }
  | { kind: 'assign' }
  | { kind: 'edit_price'; price: Price }
  | { kind: 'delete_price'; price: Price }
  | { kind: 'priority'; assignment: Assignment }
  | { kind: 'unassign'; assignment: Assignment };

function PriceListDetailPage() {
  const { priceList, prices, assignments, build } = priceListDetailRoute.useLoaderData();
  const search = priceListDetailRoute.useSearch();
  const navigate = useNavigate({ from: '/price-lists/$priceListId' });
  const website = useWebsite();
  const manage = can(useSession(), 'price_list.manage');
  const [open, setOpen] = useState<Open | undefined>();
  const [imported, setImported] = useState<PriceImportResult | undefined>();
  const [query, setQuery] = useState(search.q ?? '');
  const tab = search.tab ?? 'prices';
  const close = () => {
    setOpen(undefined);
  };
  const display = currencyDisplay(priceList.currency, website);
  const units = [...new Set(prices.items.map((p) => p.unitCode))];

  const setSearch = (change: Partial<Record<keyof DetailSearch, string | undefined>>) => {
    void navigate({
      to: '.',
      search: (prev) => {
        const next = detailSearch({ ...prev, ...change });
        delete next.after;
        return next;
      },
    });
  };

  return (
    <Page>
      <Breadcrumbs
        crumbs={[
          { label: 'Pricing' },
          { label: 'Price lists', to: '/price-lists' },
          { label: priceList.name },
        ]}
      />
      <PageHeader
        title={priceList.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_TONES[priceList.status]}>
              {STATUS_LABELS[priceList.status]}
            </Badge>
            <span className="font-mono text-[12.5px]">{priceList.currency}</span>
            <span>
              {activeDates(priceList, website)} ·{' '}
              {assignments.length === 0
                ? 'not assigned'
                : `assigned to ${assignments
                    .slice(0, 2)
                    .map((a) => a.targetName ?? TARGET_LABELS[a.target])
                    .join(
                      ', ',
                    )}${assignments.length > 2 ? ` and ${String(assignments.length - 2)} more` : ''}`}
            </span>
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setOpen({ kind: 'preview' });
              }}
            >
              <Calculator aria-hidden="true" />
              Price preview
            </Button>
            <Button variant="outline" asChild>
              <a href={pricesCsvUrl(priceList.id)} download="prices.csv">
                <Download aria-hidden="true" />
                Export CSV
              </a>
            </Button>
            {manage ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setOpen({ kind: 'import' });
                  }}
                >
                  <Upload aria-hidden="true" />
                  Import CSV
                </Button>
                <Button
                  onClick={() => {
                    setOpen({ kind: 'add' });
                  }}
                >
                  <Plus aria-hidden="true" />
                  Add price
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <BuildBanner build={build} manage={manage} />
      {imported ? (
        <Alert variant={imported.skipped.length > 0 ? 'warning' : 'info'}>
          <AlertTitle>
            Import finished: {formatCount(imported.added, website)} added,{' '}
            {formatCount(imported.updated, website)} updated
            {imported.skipped.length > 0
              ? `, ${formatCount(imported.skipped.length, website)} ${imported.skipped.length === 1 ? 'row' : 'rows'} skipped`
              : ''}
            .
          </AlertTitle>
          {imported.skipped.length > 0 ? (
            <span className="flex flex-wrap items-center gap-2 text-meta">
              {rowsSummary(imported.skipped)}
              <a
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(skippedCsv(imported.skipped))}`}
                download="skipped-rows.csv"
                className="font-semibold"
              >
                Download skipped rows
              </a>
            </span>
          ) : null}
        </Alert>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(next) => {
          void navigate({
            to: '.',
            search: next === 'prices' ? {} : { tab: next as Tab },
            replace: true,
          });
        }}
      >
        <TabsList aria-label="Price list sections">
          <TabsTrigger value="prices">
            Prices{' '}
            <TabCount>{formatCount(priceList.priceCount ?? prices.items.length, website)}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="assignments">
            Assignments <TabCount>{assignments.length}</TabCount>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prices" className="flex flex-col gap-4">
          <form
            role="search"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch({ q: query.trim() || undefined });
            }}
          >
            <Field label="Search prices" className="w-72">
              {(props) => (
                <Input
                  {...props}
                  type="search"
                  placeholder="SKU or product name"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Product unit" className="w-40">
              {({ id }) => (
                <Select
                  value={search.unit ?? ANY}
                  onValueChange={(next) => {
                    setSearch({ unit: next === ANY ? undefined : next });
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any unit</SelectItem>
                    {[...new Set([...units, ...(search.unit ? [search.unit] : [])])].map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {prices.items.length === 0 ? (
            <EmptyState
              icon={Plus}
              title={search.q || search.unit ? 'No prices match' : 'No prices yet'}
              description={
                search.q || search.unit
                  ? 'Try another SKU, name or unit.'
                  : 'Add prices one at a time, or import a CSV.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <tr>
                  <TableHead>Product</TableHead>
                  <TableHead>Product unit</TableHead>
                  <TableHead className="text-right">Minimum quantity</TableHead>
                  <TableHead className="text-right">Price ({priceList.currency})</TableHead>
                  {manage ? (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </tr>
              </TableHeader>
              <TableBody>
                {prices.items.map((price, index) => {
                  const previous = prices.items[index - 1];
                  // A tier of the same product and unit as the row above shows as a tier.
                  const tier =
                    previous?.productId === price.productId && previous.unitCode === price.unitCode;
                  return (
                    <TableRow key={price.id}>
                      <TableCell>
                        {tier ? (
                          <span className="pl-4 text-muted-foreground">↳ tier</span>
                        ) : (
                          <span>
                            <span className="font-mono text-[12.5px]">
                              {price.sku ?? price.productId}
                            </span>
                            {price.productName ? (
                              <span className="text-muted-foreground"> · {price.productName}</span>
                            ) : null}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{price.unitCode}</TableCell>
                      <TableCell className="num text-right">{price.minQuantity}</TableCell>
                      <TableCell className="num text-right">
                        {formatPrice(price.amount, priceList.currency, display)}
                      </TableCell>
                      {manage ? (
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit ${price.sku ?? 'price'} from ${price.minQuantity}`}
                            onClick={() => {
                              setOpen({ kind: 'edit_price', price });
                            }}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost-destructive"
                            size="sm"
                            aria-label={`Delete ${price.sku ?? 'price'} from ${price.minQuantity}`}
                            onClick={() => {
                              setOpen({ kind: 'delete_price', price });
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <Pager
            after={search.after}
            nextAfter={prices.nextAfter}
            limit={search.limit}
            shown={prices.items.length}
            noun="prices"
          />
        </TabsContent>

        <TabsContent value="assignments" className="flex flex-col gap-4">
          {manage ? (
            <div>
              <Button
                onClick={() => {
                  setOpen({ kind: 'assign' });
                }}
              >
                <Plus aria-hidden="true" />
                Assign
              </Button>
            </div>
          ) : null}
          {assignments.length === 0 ? (
            <EmptyState
              icon={Plus}
              title="Not assigned"
              description="Assign this price list to a customer, a customer group or a website for buyers to get its prices."
            />
          ) : (
            <Table>
              <TableHeader>
                <tr>
                  <TableHead>Assigned to</TableHead>
                  <TableHead>Website</TableHead>
                  <TableHead className="text-right">Priority</TableHead>
                  {manage ? (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </tr>
              </TableHeader>
              <TableBody>
                {assignments.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <span className="text-muted-foreground">{TARGET_LABELS[a.target]} · </span>
                      <span className="font-semibold">{a.targetName ?? a.targetId}</span>
                    </TableCell>
                    <TableCell>{a.websiteName ?? a.websiteId}</TableCell>
                    <TableCell className="num text-right">{a.priority}</TableCell>
                    {manage ? (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setOpen({ kind: 'priority', assignment: a });
                          }}
                        >
                          Priority
                        </Button>
                        <Button
                          variant="ghost-destructive"
                          size="sm"
                          onClick={() => {
                            setOpen({ kind: 'unassign', assignment: a });
                          }}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>

      {manage ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button
            variant="outline"
            onClick={() => {
              setOpen({ kind: 'edit_list' });
            }}
          >
            <Pencil aria-hidden="true" />
            Rename and dates
          </Button>
          <Button
            variant="ghost-destructive"
            disabled={assignments.length > 0}
            title={assignments.length > 0 ? 'Remove its assignments first' : undefined}
            onClick={() => {
              setOpen({ kind: 'delete_list' });
            }}
          >
            <Trash2 aria-hidden="true" />
            Delete price list
          </Button>
          {assignments.length > 0 ? (
            <span className="self-center text-meta text-muted-foreground">
              Remove its assignments before deleting it.
            </span>
          ) : null}
        </div>
      ) : null}

      <PricePreviewSheet
        open={open?.kind === 'preview'}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      />
      {manage ? (
        <>
          <ImportDialog
            priceList={priceList}
            open={open?.kind === 'import'}
            onOpenChange={(o) => {
              if (!o) close();
            }}
            onImported={setImported}
          />
          <AddPriceDialog
            priceList={priceList}
            open={open?.kind === 'add'}
            onOpenChange={(o) => {
              if (!o) close();
            }}
          />
          <AddAssignmentDialog
            priceList={priceList}
            open={open?.kind === 'assign'}
            onOpenChange={(o) => {
              if (!o) close();
            }}
          />
          {open?.kind === 'edit_list' ? (
            <EditListSheet priceList={priceList} onClose={close} />
          ) : null}
          {open?.kind === 'edit_price' ? (
            <EditPriceDialog price={open.price} onClose={close} />
          ) : null}
          {open?.kind === 'priority' ? (
            <PriorityDialog assignment={open.assignment} onClose={close} />
          ) : null}
          <ConfirmDialog
            open={open?.kind === 'delete_price'}
            onOpenChange={(o) => {
              if (!o) close();
            }}
            title="Delete this price?"
            description="Buyers keep it until the next price build."
            confirmLabel="Delete price"
            onConfirm={async () => {
              if (open?.kind === 'delete_price') await deletePrice(open.price.id);
            }}
          />
          <ConfirmDialog
            open={open?.kind === 'unassign'}
            onOpenChange={(o) => {
              if (!o) close();
            }}
            title="Remove this assignment?"
            description="Its buyers fall back to the next price list in the chain after the next build."
            confirmLabel="Remove"
            onConfirm={async () => {
              if (open?.kind === 'unassign') await deleteAssignment(open.assignment.id);
            }}
          />
          <ConfirmDialog
            open={open?.kind === 'delete_list'}
            onOpenChange={(o) => {
              if (!o) close();
            }}
            title={`Delete ${priceList.name}?`}
            description="Its prices are deleted too. This cannot be undone."
            confirmLabel="Delete price list"
            onConfirm={async () => {
              await deletePriceList(priceList.id);
              await navigate({ to: '/price-lists', search: {} });
            }}
          />
        </>
      ) : null}
    </Page>
  );
}
