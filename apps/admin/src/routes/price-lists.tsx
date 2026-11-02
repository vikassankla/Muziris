import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Calculator, Plus, Tags } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { BuildBanner, PricePreviewSheet } from '../components/pricing.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
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
import {
  createPriceList,
  getPriceBuild,
  listPriceLists,
  PRICE_LIST_STATUSES,
  type PriceList,
  type PriceListStatus,
} from '../lib/endpoints.js';
import { formatCount } from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { activeDates, dayStart } from '../lib/price-dates.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// Price lists (ADR 0022, PriceLists board): every price list with its status, prices and where
// it is assigned, and the build banner.

interface PriceListsSearch extends ListSearch {
  currency?: 'INR' | 'USD';
  state?: PriceListStatus;
}

const ANY = '__any';

export const STATUS_LABELS: Record<PriceListStatus, string> = {
  scheduled: 'Scheduled',
  active: 'Active',
  expired: 'Expired',
};
export const STATUS_TONES: Record<PriceListStatus, 'info' | 'success' | 'neutral'> = {
  scheduled: 'info',
  active: 'success',
  expired: 'neutral',
};

function priceListsSearch(search: Record<string, unknown>): PriceListsSearch {
  const out: PriceListsSearch = listSearch(search);
  const currency = search['currency'];
  if (currency === 'INR' || currency === 'USD') out.currency = currency;
  const state = search['state'];
  if ((PRICE_LIST_STATUSES as readonly unknown[]).includes(state)) {
    out.state = state as PriceListStatus;
  }
  return out;
}

export const priceListsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/price-lists',
  validateSearch: priceListsSearch,
  loaderDeps: ({ search }) => ({
    after: search.after,
    limit: search.limit,
    currency: search.currency,
  }),
  loader: async ({ deps, abortController }) => {
    const [lists, build] = await Promise.all([
      listPriceLists(deps, abortController.signal),
      getPriceBuild(abortController.signal),
    ]);
    return { lists, build };
  },
  component: PriceListsPage,
});

function NewPriceListSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const website = useWebsite();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<string>(website.currency);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await submit(
      () =>
        createPriceList({
          name,
          currency,
          activeFrom: from ? dayStart(from, website.timeZone) : null,
          activeUntil: until ? dayStart(until, website.timeZone, 1) : null,
        }),
      { title: 'Price list created', description: name },
    );
    if (created) {
      await navigate({
        to: '/price-lists/$priceListId',
        params: { priceListId: created.id },
        search: {},
      });
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New price list</SheetTitle>
          <SheetDescription>
            Add prices and assign it to customers, customer groups or websites after saving. The
            currency cannot be changed later.
          </SheetDescription>
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
            <Field label="Currency">
              {({ id }) => (
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INR">INR, Indian rupee</SelectItem>
                    <SelectItem value="USD">USD, US dollar</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Active from"
                optional
                hint={`From the start of the day, ${website.meta.split(' · ')[1] ?? ''}.`}
              >
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
              <Field
                label="Active until"
                optional
                hint="Through the end of this day."
                error={errors['activeUntil']}
              >
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
              Create price list
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function PriceListsPage() {
  const { lists, build } = priceListsRoute.useLoaderData();
  const search = priceListsRoute.useSearch();
  const navigate = useNavigate({ from: '/price-lists' });
  const website = useWebsite();
  const manage = can(useSession(), 'price_list.manage');
  const [previewOpen, setPreviewOpen] = useState(false);
  const setSearch = (change: {
    [K in keyof PriceListsSearch]?: PriceListsSearch[K] | undefined;
  }) => {
    void navigate({
      to: '.',
      search: (prev) => {
        const next = priceListsSearch({ ...prev, ...change });
        delete next.after;
        return next;
      },
    });
  };
  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew(open) });
  };
  // The API filters by currency; the status is worked out for now, so it is filtered here.
  const shown: PriceList[] =
    search.state === undefined ? lists.items : lists.items.filter((l) => l.status === search.state);
  const newButton = manage ? (
    <Button
      onClick={() => {
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New price list
    </Button>
  ) : null;

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Pricing' }, { label: 'Price lists' }]} />
      <PageHeader
        title="Price lists"
        description="Negotiated and list prices. A buyer gets the first price found: customer, then customer group, then website."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setPreviewOpen(true);
              }}
            >
              <Calculator aria-hidden="true" />
              Price preview
            </Button>
            {newButton}
          </>
        }
      />
      <BuildBanner build={build} manage={manage} />
      <div className="flex flex-wrap gap-3">
        <Field label="Currency" className="w-44">
          {({ id }) => (
            <Select
              value={search.currency ?? ANY}
              onValueChange={(next) => {
                setSearch({ currency: next === ANY ? undefined : (next as 'INR' | 'USD') });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any currency</SelectItem>
                <SelectItem value="INR">INR</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Status" className="w-44">
          {({ id }) => (
            <Select
              value={search.state ?? ANY}
              onValueChange={(next) => {
                setSearch({ state: next === ANY ? undefined : (next as PriceListStatus) });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {PRICE_LIST_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon={Tags}
          title={lists.items.length === 0 ? 'No price lists yet' : 'No price lists match'}
          description={
            lists.items.length === 0
              ? 'Until a price list is assigned and built, buyers see “Price on request”.'
              : 'Try another currency or status.'
          }
          action={lists.items.length === 0 ? (newButton ?? undefined) : undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Name</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Prices</TableHead>
              <TableHead className="text-right">Assignments</TableHead>
              <TableHead>Active dates</TableHead>
              <TableHead>Status</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {shown.map((list) => (
              <TableRow key={list.id}>
                <TableCell className="font-semibold">
                  <Link
                    to="/price-lists/$priceListId"
                    params={{ priceListId: list.id }}
                    search={{}}
                  >
                    {list.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-[12.5px]">{list.currency}</TableCell>
                <TableCell className="num text-right">
                  {formatCount(list.priceCount ?? 0, website)}
                </TableCell>
                <TableCell className="num text-right">
                  {list.assignmentCount === 0 ? (
                    <span className="text-muted-foreground">Not assigned</span>
                  ) : (
                    formatCount(list.assignmentCount ?? 0, website)
                  )}
                </TableCell>
                <TableCell>{activeDates(list, website)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_TONES[list.status]}>{STATUS_LABELS[list.status]}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager
        after={search.after}
        nextAfter={lists.nextAfter}
        limit={search.limit}
        shown={lists.items.length}
        noun="price lists"
      />
      {manage ? <NewPriceListSheet open={search.new === true} onOpenChange={setNew} /> : null}
      <PricePreviewSheet open={previewOpen} onOpenChange={setPreviewOpen} />
    </Page>
  );
}
