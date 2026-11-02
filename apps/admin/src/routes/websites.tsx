import { createRoute, useNavigate } from '@tanstack/react-router';
import { Globe, Pencil, Plus } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState, NoAccess } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
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
import { Switch } from '../components/ui/switch.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { createWebsite, listWebsites, updateWebsite, type Website } from '../lib/endpoints.js';
import {
  formatAmount,
  formatDateTime,
  formatQuantity,
  type DisplayContext,
} from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { authedRoute } from './authed.js';

// Websites (ADR 0021): where the business sells, each with its country, currency, language and
// time zone. Code, country and currency are fixed once a website exists.

export const websitesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/websites',
  validateSearch: listSearch,
  loader: ({ abortController }) => listWebsites(abortController.signal),
  component: WebsitesPage,
});

type Country = 'IN' | 'US';

/** The pilot's two countries and what a new website there starts with. */
const COUNTRIES: Record<
  Country,
  {
    name: string;
    currency: 'INR' | 'USD';
    locale: 'en-IN' | 'en-US';
    timeZone: string;
    unitSystem: 'metric' | 'imperial';
  }
> = {
  IN: {
    name: 'India',
    currency: 'INR',
    locale: 'en-IN',
    timeZone: 'Asia/Kolkata',
    unitSystem: 'metric',
  },
  US: {
    name: 'United States',
    currency: 'USD',
    locale: 'en-US',
    timeZone: 'America/Chicago',
    unitSystem: 'imperial',
  },
};

const LOCALES = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-US', label: 'English (United States)' },
] as const;

const TIME_ZONES: Record<Country, string[]> = {
  IN: ['Asia/Kolkata'],
  US: [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
  ],
};

const WEBSITE_CODE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A sample amount, date and quantity in a website's formats. */
function FormatPreview({ display }: { display: DisplayContext }) {
  const kg = { code: 'kg', name: 'Kilogram', precision: 3 };
  return (
    <dl
      aria-label="How this website formats"
      className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/40 p-3 text-meta"
    >
      <dt className="text-muted-foreground">Money</dt>
      <dd className="num m-0">{formatAmount('1234567.50', display)}</dd>
      <dt className="text-muted-foreground">Date and time</dt>
      <dd className="num m-0">{formatDateTime('2026-11-20T06:00:00.000Z', display)}</dd>
      <dt className="text-muted-foreground">Quantity</dt>
      <dd className="num m-0">{formatQuantity('1250.5', kg, display)}</dd>
    </dl>
  );
}

function WebsiteSheet({
  website,
  open,
  onOpenChange,
}: {
  /** The website to edit; left out to create one. */
  website?: Website | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const initialCountry: Country = website?.countryCode === 'US' ? 'US' : 'IN';
  const [country, setCountry] = useState<Country>(initialCountry);
  const [code, setCode] = useState(website?.code ?? '');
  const [name, setName] = useState(website?.name ?? '');
  const [locale, setLocale] = useState<string>(
    website?.defaultLocale ?? COUNTRIES[initialCountry].locale,
  );
  const [timeZone, setTimeZone] = useState(website?.timeZone ?? COUNTRIES[initialCountry].timeZone);
  const [unitSystem, setUnitSystem] = useState<'metric' | 'imperial'>(
    website?.unitSystem ?? COUNTRIES[initialCountry].unitSystem,
  );
  const [isActive, setIsActive] = useState(website?.isActive ?? true);
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const currency = website
    ? website.defaultCurrency === 'USD'
      ? 'USD'
      : 'INR'
    : COUNTRIES[country].currency;
  const codeError =
    problem?.code === 'website_code_taken'
      ? 'A website with this code already exists.'
      : !website && code !== '' && !WEBSITE_CODE.test(code)
        ? 'Use 2 to 63 lowercase letters, digits or hyphens.'
        : errors['code'];
  const zones = TIME_ZONES[country].includes(timeZone)
    ? TIME_ZONES[country]
    : [timeZone, ...TIME_ZONES[country]];

  function chooseCountry(next: Country) {
    setCountry(next);
    setLocale(COUNTRIES[next].locale);
    setTimeZone(COUNTRIES[next].timeZone);
    setUnitSystem(COUNTRIES[next].unitSystem);
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = website
      ? await submit(
          () =>
            updateWebsite(website.id, {
              name,
              defaultLocale: locale,
              timeZone,
              unitSystem,
              isActive,
            }),
          { title: 'Website saved', description: name },
        )
      : await submit(
          () =>
            createWebsite({
              code,
              name,
              countryCode: country,
              defaultCurrency: currency,
              defaultLocale: locale,
              timeZone,
              unitSystem,
            }),
          { title: 'Website created', description: name },
        );
    if (saved) onOpenChange(false);
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
          <SheetTitle>{website ? website.name : 'New website'}</SheetTitle>
          <SheetDescription>
            {website
              ? 'Code, country and currency are fixed once a website exists.'
              : 'Code, country and currency cannot be changed later.'}
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            {problem &&
            problem.code !== 'validation_failed' &&
            problem.code !== 'website_code_taken' ? (
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
              <Field
                label="Code"
                hint={website ? undefined : 'Used in URLs and exports.'}
                error={codeError}
              >
                {(props) => (
                  <Input
                    {...props}
                    required
                    readOnly={website !== undefined}
                    className="font-mono"
                    maxLength={63}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Country">
                {({ id }) => (
                  <Select
                    value={country}
                    disabled={website !== undefined}
                    onValueChange={(next) => {
                      chooseCountry(next as Country);
                    }}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(COUNTRIES) as Country[]).map((c) => (
                        <SelectItem key={c} value={c}>
                          {COUNTRIES[c].name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Currency" hint="Set by the country.">
                {(props) => <Input {...props} readOnly className="font-mono" value={currency} />}
              </Field>
              <Field label="Language and formats" error={errors['defaultLocale']}>
                {({ id }) => (
                  <Select value={locale} onValueChange={setLocale}>
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCALES.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Time zone" error={errors['timeZone']}>
                {({ id }) => (
                  <Select value={timeZone} onValueChange={setTimeZone}>
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {zones.map((z) => (
                        <SelectItem key={z} value={z}>
                          {z}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="Units">
                {({ id }) => (
                  <Select
                    value={unitSystem}
                    onValueChange={(next) => {
                      setUnitSystem(next as 'metric' | 'imperial');
                    }}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="metric">Metric</SelectItem>
                      <SelectItem value="imperial">Imperial</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
            <FormatPreview
              display={{ locale: locale === 'en-US' ? 'en-US' : 'en-IN', currency, timeZone }}
            />
            {website ? (
              <div className="flex items-center gap-2.5">
                <Switch id="website-active" checked={isActive} onCheckedChange={setIsActive} />
                <label htmlFor="website-active">{isActive ? 'Active' : 'Inactive'}</label>
                <span className="text-meta text-muted-foreground">
                  {isActive
                    ? 'Buyers can use its storefront.'
                    : 'Its storefront answers as if it did not exist.'}
                </span>
              </div>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending}>
              {website ? 'Save website' : 'Create website'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function WebsitesPage() {
  const websites = websitesRoute.useLoaderData();
  const search = websitesRoute.useSearch();
  const navigate = useNavigate();
  const session = useSession();
  const manage = can(session, 'website.manage');
  const [editing, setEditing] = useState<Website | undefined>();
  if (!can(session, 'website.view')) return <NoAccess />;

  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew<ListSearch>(open) });
  };
  const newButton = manage ? (
    <Button
      onClick={() => {
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New website
    </Button>
  ) : null;
  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Websites' }]} />
      <PageHeader
        title="Websites"
        description="Where you sell: each website has its own country, currency, language and time zone."
        actions={newButton}
      />
      {websites.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No websites yet"
          description="Create the first website before buyers can sign in to a storefront."
          action={newButton ?? undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Time zone</TableHead>
              <TableHead>Status</TableHead>
              {manage ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </tr>
          </TableHeader>
          <TableBody>
            {websites.map((website) => (
              <TableRow key={website.id}>
                <TableCell className="font-mono text-[12.5px]">{website.code}</TableCell>
                <TableCell className="font-semibold">{website.name}</TableCell>
                <TableCell>
                  {website.countryCode === 'IN' || website.countryCode === 'US'
                    ? COUNTRIES[website.countryCode].name
                    : website.countryCode}
                </TableCell>
                <TableCell className="font-mono text-[12.5px]">{website.defaultCurrency}</TableCell>
                <TableCell>{website.timeZone}</TableCell>
                <TableCell>
                  {website.isActive ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="neutral">Inactive</Badge>
                  )}
                </TableCell>
                {manage ? (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${website.name}`}
                      onClick={() => {
                        setEditing(website);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      Edit
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {websites.length > 0 && !websites.some((w) => w.isActive) ? (
        <Alert variant="warning">No website is active, so no storefront answers buyers.</Alert>
      ) : null}
      {manage ? (
        <>
          <WebsiteSheet open={search.new === true} onOpenChange={setNew} />
          {editing ? (
            <WebsiteSheet
              key={editing.id}
              website={editing}
              open
              onOpenChange={(open) => {
                if (!open) setEditing(undefined);
              }}
            />
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
