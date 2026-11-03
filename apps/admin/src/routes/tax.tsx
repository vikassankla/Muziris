import { createRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { CheckCircle2, CircleAlert, Plus, Receipt, Upload } from 'lucide-react';
import { useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { Combobox } from '../components/combobox.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Alert, AlertTitle } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Checkbox } from '../components/ui/checkbox.js';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { TabCount, Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { GST_STATE_CODES, US_STATES } from '../lib/address-rules.js';
import {
  addExemption,
  addGstRate,
  addUsRate,
  addUsRegistration,
  deleteExemption,
  deleteTaxRate,
  deleteTaxRegistration,
  endTaxRate,
  getTaxReadiness,
  importUsRates,
  listCustomers,
  listExemptions,
  listGstRates,
  listTaxRegistrations,
  listUsRates,
  setGstRegistration,
  type Exemption,
  type GstRate,
  type TaxReadiness,
  type TaxRegistration,
  type UsRate,
} from '../lib/endpoints.js';
import { formatCount, formatDay, type DisplayContext } from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// Tax (ADR 0023): for the website chosen in the top bar, what would refuse checkout today and
// the tables the tax engine (ADR 0017) charges from: registrations, rates and, in the US,
// customer exemption certificates. Changes need tax.manage; without it every tab is read-only.

const TABS = ['readiness', 'registration', 'rates', 'exemptions'] as const;
type TaxTab = (typeof TABS)[number];

interface TaxSearch {
  /** The website the screen shows; kept in step with the top bar. */
  website?: string;
  tab?: TaxTab;
}

function taxSearch(search: Record<string, unknown>): TaxSearch {
  const out: TaxSearch = {};
  const website = search['website'];
  if (typeof website === 'string' && website.length > 0 && website.length <= 100) {
    out.website = website;
  }
  const tab = search['tab'];
  if ((TABS as readonly unknown[]).includes(tab) && tab !== 'readiness') out.tab = tab as TaxTab;
  return out;
}

export const taxRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/tax',
  validateSearch: taxSearch,
  loaderDeps: ({ search }) => ({ website: search.website }),
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal;
    if (deps.website === undefined) return undefined;
    const [readiness, registrations] = await Promise.all([
      getTaxReadiness(deps.website, signal),
      listTaxRegistrations(deps.website, signal),
    ]);
    if (readiness.countryCode === 'IN') {
      return { readiness, registrations, gstRates: await listGstRates({}, signal) };
    }
    const [usRates, exemptions, customers] = await Promise.all([
      listUsRates({}, signal),
      listExemptions({}, signal),
      listCustomers({ limit: 200 }, signal),
    ]);
    return {
      readiness,
      registrations,
      usRates,
      exemptions,
      customers: customers.items.map((c) => ({ value: c.id, label: c.name })),
    };
  },
  component: TaxPage,
});

// Rate periods ---------------------------------------------------------------------------------

/** One day after or before a YYYY-MM-DD day. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today in a time zone, as YYYY-MM-DD. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** A rate's period in words; the API's validTo is the first day it no longer applies. */
function period(rate: { validFrom: string; validTo: string | null }, ctx: DisplayContext): string {
  return rate.validTo === null
    ? `From ${formatDay(rate.validFrom, ctx)}`
    : `${formatDay(rate.validFrom, ctx)} to ${formatDay(addDays(rate.validTo, -1), ctx)}`;
}

function RateState({
  rate,
  today,
}: {
  rate: { validFrom: string; validTo: string | null };
  today: string;
}) {
  if (rate.validFrom > today) return <Badge variant="info">Scheduled</Badge>;
  if (rate.validTo !== null && rate.validTo <= today) return <Badge variant="neutral">Ended</Badge>;
  return <Badge variant="success">In force</Badge>;
}

function gstState(gstin: string): string {
  const code = gstin.slice(0, 2);
  return GST_STATE_CODES[code] ?? `State ${code}`;
}

function stateName(code: string): string {
  return US_STATES[code] ?? code;
}

// A small form in a dialog ---------------------------------------------------------------------

function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  onSubmit,
  success,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  submitLabel: string;
  onSubmit: () => Promise<unknown>;
  success: string;
  children: (errors: Record<string, string>) => ReactNode;
}) {
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const done = await submit(
      async () => {
        await onSubmit();
        return true;
      },
      { title: success },
    );
    if (done) onOpenChange(false);
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          {children(errors)}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DayField({
  label,
  value,
  onChange,
  hint,
  error,
  optional = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | undefined;
  optional?: boolean;
}) {
  return (
    <Field label={label} optional={optional} hint={hint} error={error}>
      {(props) => (
        <Input
          {...props}
          type="date"
          required={!optional}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}
    </Field>
  );
}

function StateSelect({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  return (
    <Field label="State" error={error}>
      {({ id }) => (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Choose a state" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(US_STATES).map(([code, name]) => (
              <SelectItem key={code} value={code}>
                {name} ({code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}

// Readiness ------------------------------------------------------------------------------------

const ITEM_TITLES: Record<string, { ok: string; missing: string }> = {
  gst_registration_missing: {
    ok: 'The website has a GSTIN',
    missing: 'The website has no GSTIN',
  },
  products_missing_tax_code: {
    ok: 'Every enabled product has an HSN or SAC code',
    missing: 'Enabled products without an HSN or SAC code',
  },
  tax_codes_without_rate: {
    ok: 'A GST rate covers every code in use today',
    missing: 'Codes in use that no GST rate covers today',
  },
  us_permit_missing: {
    ok: 'The website has a sales tax permit',
    missing: 'The website has no sales tax permit',
  },
  states_without_rate: {
    ok: 'Every state with a permit has a statewide rate today',
    missing: 'States with a permit and no statewide rate today',
  },
};

/** Items that list things; a missing registration is one thing, so it shows no count. */
const COUNTED = new Set([
  'products_missing_tax_code',
  'tax_codes_without_rate',
  'states_without_rate',
]);

function exampleText(code: string, example: Record<string, unknown>): string {
  const text = (key: string) => {
    const value = example[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  };
  switch (code) {
    case 'products_missing_tax_code':
      return `${text('sku')} ${text('name')}`;
    case 'tax_codes_without_rate':
      return `${text('code')} (${text('productCount')} products)`;
    case 'states_without_rate':
      return stateName(text('stateCode'));
    default:
      return '';
  }
}

function ReadinessTab({
  readiness,
  onTab,
}: {
  readiness: TaxReadiness;
  onTab: (tab: TaxTab) => void;
}) {
  const website = useWebsite();
  const fix = (code: string): ReactNode => {
    switch (code) {
      case 'products_missing_tax_code':
        return (
          <Link to="/products" search={{ missingTaxCode: true }}>
            Show these products
          </Link>
        );
      case 'gst_registration_missing':
      case 'us_permit_missing':
        return (
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => {
              onTab('registration');
            }}
          >
            Add the registration
          </Button>
        );
      default:
        return (
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => {
              onTab('rates');
            }}
          >
            Add a rate
          </Button>
        );
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {readiness.ready ? (
        <Alert variant="info" icon={<CheckCircle2 />}>
          <AlertTitle>Checkout can charge tax on this website today.</AlertTitle>
        </Alert>
      ) : (
        <Alert variant="warning">
          <AlertTitle>Checkout refuses orders on this website until these are fixed.</AlertTitle>
        </Alert>
      )}
      <Card>
        <CardContent className="flex flex-col divide-y p-0">
          {readiness.items.map((item) => {
            const titles = ITEM_TITLES[item.code];
            return (
              <div key={item.code} className="flex items-start gap-3 px-4 py-3">
                {item.ok ? (
                  <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 text-success" />
                ) : (
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 text-warning" />
                )}
                <div className="flex flex-1 flex-col gap-1">
                  <span className="font-semibold">
                    {item.ok ? (titles?.ok ?? item.code) : (titles?.missing ?? item.code)}
                    {!item.ok && COUNTED.has(item.code) ? (
                      <span className="num ml-2 text-muted-foreground">
                        {formatCount(item.count, website)}
                      </span>
                    ) : null}
                  </span>
                  {!item.ok && item.examples.length > 0 ? (
                    <span className="text-meta text-muted-foreground">
                      {item.examples.map((e) => exampleText(item.code, e)).join(', ')}
                      {item.count > item.examples.length ? ', and more' : ''}
                    </span>
                  ) : null}
                </div>
                {item.ok ? null : <div className="text-meta">{fix(item.code)}</div>}
              </div>
            );
          })}
        </CardContent>
      </Card>
      <p className="text-meta text-muted-foreground">
        As of {formatDay(readiness.day, website)}, in the website’s time zone.
      </p>
    </div>
  );
}

// Registration ---------------------------------------------------------------------------------

function GstRegistrationCard({
  websiteId,
  registration,
  manage,
}: {
  websiteId: string;
  registration: TaxRegistration | undefined;
  manage: boolean;
}) {
  const [gstin, setGstin] = useState(registration?.number ?? '');
  const { pending, problem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const typed = gstin.trim().toUpperCase();

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(() => setGstRegistration(websiteId, typed), { title: 'GSTIN saved' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GST registration</CardTitle>
        <span className="text-meta text-muted-foreground">
          {registration
            ? `${registration.number}, ${gstState(registration.number)}`
            : 'No GSTIN yet'}
        </span>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field
            label="GSTIN"
            hint={
              typed.length >= 2
                ? `State: ${gstState(typed)}`
                : '15 characters, from the GST portal.'
            }
            error={errors['gstin']}
          >
            {(props) => (
              <Input
                {...props}
                className="font-mono"
                maxLength={15}
                required
                disabled={!manage}
                value={gstin}
                onChange={(e) => {
                  setGstin(e.target.value);
                }}
              />
            )}
          </Field>
          {manage ? (
            <div>
              <Button type="submit" disabled={pending || typed === (registration?.number ?? '')}>
                Save GSTIN
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function UsPermitsCard({
  websiteId,
  permits,
  manage,
}: {
  websiteId: string;
  permits: readonly TaxRegistration[];
  manage: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TaxRegistration | undefined>();
  const [stateCode, setStateCode] = useState('');
  const [permitNumber, setPermitNumber] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sales tax permits</CardTitle>
        {manage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setStateCode('');
              setPermitNumber('');
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            Add permit
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {permits.length === 0 ? (
          <p className="text-muted-foreground">
            No permits. Tax is charged only in states with a permit.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                <TableHead>State</TableHead>
                <TableHead>Permit number</TableHead>
                {manage ? <TableHead className="w-24" /> : null}
              </tr>
            </TableHeader>
            <TableBody>
              {permits.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{stateName(p.regionCode)}</TableCell>
                  <TableCell className="font-mono text-[12.5px]">{p.number}</TableCell>
                  {manage ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRemoving(p);
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
      </CardContent>
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a sales tax permit"
        description="Tax is charged on orders shipped to a state with a permit."
        submitLabel="Add permit"
        success="Permit added"
        onSubmit={() => addUsRegistration(websiteId, { stateCode, permitNumber })}
      >
        {(errors) => (
          <>
            <StateSelect value={stateCode} onChange={setStateCode} error={errors['stateCode']} />
            <Field label="Permit number" error={errors['permitNumber']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={50}
                  value={permitNumber}
                  onChange={(e) => {
                    setPermitNumber(e.target.value);
                  }}
                />
              )}
            </Field>
          </>
        )}
      </FormDialog>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(o) => {
          if (!o) setRemoving(undefined);
        }}
        title={`Remove the ${removing ? stateName(removing.regionCode) : ''} permit?`}
        description="Orders shipped to this state are then charged no sales tax."
        confirmLabel="Remove permit"
        onConfirm={async () => {
          if (removing) await deleteTaxRegistration(removing.id);
          await router.invalidate();
        }}
      />
    </Card>
  );
}

// Rates ----------------------------------------------------------------------------------------

type AnyRate = { kind: 'gst'; rate: GstRate } | { kind: 'us'; rate: UsRate };

function EndRateDialog({ target, onClose }: { target: AnyRate | undefined; onClose: () => void }) {
  // Keyed by the rate, so the field starts from that rate's last day.
  const [lastDay, setLastDay] = useState(
    target?.rate.validTo ? addDays(target.rate.validTo, -1) : '',
  );
  return (
    <FormDialog
      open={target !== undefined}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="End this rate"
      description="Orders after the last day need another rate, or checkout refuses them."
      submitLabel="Save"
      success="Rate updated"
      onSubmit={async () => {
        if (target) {
          await endTaxRate(target.kind, target.rate.id, lastDay ? addDays(lastDay, 1) : null);
        }
      }}
    >
      {(errors) => (
        <DayField
          label="Last day"
          optional
          hint="Left empty, the rate has no end."
          value={lastDay}
          onChange={setLastDay}
          error={errors['validTo']}
        />
      )}
    </FormDialog>
  );
}

function RateActions({
  target,
  onEnd,
  onDelete,
}: {
  target: AnyRate;
  onEnd: (target: AnyRate) => void;
  onDelete: (target: AnyRate) => void;
}) {
  return (
    <TableCell className="whitespace-nowrap text-right">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onEnd(target);
        }}
      >
        End
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onDelete(target);
        }}
      >
        Delete
      </Button>
    </TableCell>
  );
}

function GstRatesCard({
  rates,
  manage,
  today,
}: {
  rates: readonly GstRate[];
  manage: boolean;
  today: string;
}) {
  const website = useWebsite();
  const [adding, setAdding] = useState(false);
  const [codePrefix, setCodePrefix] = useState('');
  const [ratePercent, setRatePercent] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [lastDay, setLastDay] = useState('');
  const [ending, setEnding] = useState<AnyRate | undefined>();
  const [deleting, setDeleting] = useState<AnyRate | undefined>();
  const router = useRouter();
  const sorted = [...rates].sort(
    (a, b) => a.codePrefix.localeCompare(b.codePrefix) || a.validFrom.localeCompare(b.validFrom),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>GST rates</CardTitle>
        <span className="text-meta text-muted-foreground">
          A product takes the rate with the longest HSN or SAC prefix that matches its code.
        </span>
        {manage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCodePrefix('');
              setRatePercent('');
              setValidFrom(today);
              setLastDay('');
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            Add rate
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-muted-foreground">No GST rates yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                <TableHead>HSN or SAC prefix</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Applies</TableHead>
                <TableHead>Status</TableHead>
                {manage ? <TableHead /> : null}
              </tr>
            </TableHeader>
            <TableBody>
              {sorted.map((rate) => (
                <TableRow key={rate.id}>
                  <TableCell className="num">{rate.codePrefix}</TableCell>
                  <TableCell className="num text-right">{rate.ratePercent}%</TableCell>
                  <TableCell>{period(rate, website)}</TableCell>
                  <TableCell>
                    <RateState rate={rate} today={today} />
                  </TableCell>
                  {manage ? (
                    <RateActions
                      target={{ kind: 'gst', rate }}
                      onEnd={setEnding}
                      onDelete={setDeleting}
                    />
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a GST rate"
        description="Rates for the same prefix may not overlap in time."
        submitLabel="Add rate"
        success="GST rate added"
        onSubmit={() =>
          addGstRate({
            codePrefix: codePrefix.trim(),
            ratePercent: ratePercent.trim(),
            validFrom,
            validTo: lastDay ? addDays(lastDay, 1) : null,
          })
        }
      >
        {(errors) => (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field label="HSN or SAC prefix" hint="2 to 8 digits." error={errors['codePrefix']}>
                {(props) => (
                  <Input
                    {...props}
                    className="num"
                    inputMode="numeric"
                    required
                    maxLength={8}
                    value={codePrefix}
                    onChange={(e) => {
                      setCodePrefix(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Rate (%)" error={errors['ratePercent']}>
                {(props) => (
                  <Input
                    {...props}
                    className="num"
                    inputMode="decimal"
                    required
                    value={ratePercent}
                    onChange={(e) => {
                      setRatePercent(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <DayField
                label="First day"
                value={validFrom}
                onChange={setValidFrom}
                error={errors['validFrom']}
              />
              <DayField
                label="Last day"
                optional
                value={lastDay}
                onChange={setLastDay}
                error={errors['validTo']}
              />
            </div>
          </>
        )}
      </FormDialog>
      <EndRateDialog
        key={ending?.rate.id ?? 'none'}
        target={ending}
        onClose={() => {
          setEnding(undefined);
        }}
      />
      <DeleteRateDialog
        target={deleting}
        onClose={() => {
          setDeleting(undefined);
        }}
        onDeleted={() => router.invalidate()}
      />
    </Card>
  );
}

function DeleteRateDialog({
  target,
  onClose,
  onDeleted,
}: {
  target: AnyRate | undefined;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={target !== undefined}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Delete this rate?"
      description="Orders already placed keep the tax they were charged. To stop a rate from a day on, end it instead."
      confirmLabel="Delete rate"
      onConfirm={async () => {
        if (target) await deleteTaxRate(target.kind, target.rate.id);
        await onDeleted();
      }}
    />
  );
}

function ImportUsRatesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [csv, setCsv] = useState<string | undefined>();
  const [fileName, setFileName] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const rowErrors = problem?.code === 'invalid_import' ? problem.errors : [];

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (csv === undefined) return;
    const result = await submit(() => importUsRates(csv));
    if (result) {
      toast.success('US rates imported', { description: `${String(result.imported)} rates` });
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
          <DialogTitle>Import US rates</DialogTitle>
          <DialogDescription>
            A CSV with the columns state, zip_prefix, rate_percent, shipping_taxable, valid_from and
            valid_to, at most 5,000 rows. Every row is imported, or none.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <Field label="CSV file" hint={fileName || undefined}>
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
          {problem && rowErrors.length === 0 ? <ProblemAlert problem={problem} /> : null}
          {rowErrors.length > 0 ? (
            <Alert variant="warning">
              <AlertTitle>{problem?.title}</AlertTitle>
              <ul className="m-0 list-none p-0 text-meta">
                {rowErrors.slice(0, 20).map((e) => (
                  <li key={`${e.path} ${e.message}`}>
                    {e.path[0]?.toUpperCase()}
                    {e.path.slice(1)}: {e.message}
                  </li>
                ))}
                {rowErrors.length > 20 ? (
                  <li>and {String(rowErrors.length - 20)} more rows</li>
                ) : null}
              </ul>
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
            <Button type="submit" disabled={pending || csv === undefined}>
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UsRatesCard({
  rates,
  manage,
  today,
}: {
  rates: readonly UsRate[];
  manage: boolean;
  today: string;
}) {
  const website = useWebsite();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [stateCode, setStateCode] = useState('');
  const [zipPrefix, setZipPrefix] = useState('');
  const [ratePercent, setRatePercent] = useState('');
  const [shippingTaxable, setShippingTaxable] = useState(false);
  const [validFrom, setValidFrom] = useState('');
  const [lastDay, setLastDay] = useState('');
  const [ending, setEnding] = useState<AnyRate | undefined>();
  const [deleting, setDeleting] = useState<AnyRate | undefined>();
  const router = useRouter();
  const sorted = [...rates].sort(
    (a, b) =>
      a.stateCode.localeCompare(b.stateCode) ||
      (a.zipPrefix ?? '').localeCompare(b.zipPrefix ?? '') ||
      a.validFrom.localeCompare(b.validFrom),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>US sales tax rates</CardTitle>
        <span className="text-meta text-muted-foreground">
          An order takes the rate with the longest ZIP prefix that matches its ZIP code, else the
          statewide rate.
        </span>
        {manage ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setImporting(true);
              }}
            >
              <Upload aria-hidden="true" />
              Import CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStateCode('');
                setZipPrefix('');
                setRatePercent('');
                setShippingTaxable(false);
                setValidFrom(today);
                setLastDay('');
                setAdding(true);
              }}
            >
              <Plus aria-hidden="true" />
              Add rate
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-muted-foreground">No US rates yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                <TableHead>State</TableHead>
                <TableHead>ZIP prefix</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Shipping</TableHead>
                <TableHead>Applies</TableHead>
                <TableHead>Status</TableHead>
                {manage ? <TableHead /> : null}
              </tr>
            </TableHeader>
            <TableBody>
              {sorted.map((rate) => (
                <TableRow key={rate.id}>
                  <TableCell>{stateName(rate.stateCode)}</TableCell>
                  <TableCell className="num">
                    {rate.zipPrefix ?? <span className="text-muted-foreground">Statewide</span>}
                  </TableCell>
                  <TableCell className="num text-right">{rate.ratePercent}%</TableCell>
                  <TableCell>{rate.shippingTaxable ? 'Taxable' : 'Not taxable'}</TableCell>
                  <TableCell>{period(rate, website)}</TableCell>
                  <TableCell>
                    <RateState rate={rate} today={today} />
                  </TableCell>
                  {manage ? (
                    <RateActions
                      target={{ kind: 'us', rate }}
                      onEnd={setEnding}
                      onDelete={setDeleting}
                    />
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a US rate"
        description="Rates for the same state and ZIP prefix may not overlap in time."
        submitLabel="Add rate"
        success="US rate added"
        onSubmit={() =>
          addUsRate({
            stateCode,
            zipPrefix: zipPrefix.trim() === '' ? null : zipPrefix.trim(),
            ratePercent: ratePercent.trim(),
            shippingTaxable,
            validFrom,
            validTo: lastDay ? addDays(lastDay, 1) : null,
          })
        }
      >
        {(errors) => (
          <>
            <StateSelect value={stateCode} onChange={setStateCode} error={errors['stateCode']} />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="ZIP prefix"
                optional
                hint="Left empty, the rate is statewide."
                error={errors['zipPrefix']}
              >
                {(props) => (
                  <Input
                    {...props}
                    className="num"
                    inputMode="numeric"
                    maxLength={5}
                    value={zipPrefix}
                    onChange={(e) => {
                      setZipPrefix(e.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Rate (%)" error={errors['ratePercent']}>
                {(props) => (
                  <Input
                    {...props}
                    className="num"
                    inputMode="decimal"
                    required
                    value={ratePercent}
                    onChange={(e) => {
                      setRatePercent(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={shippingTaxable}
                onCheckedChange={(checked) => {
                  setShippingTaxable(checked === true);
                }}
              />
              Shipping is taxable
            </label>
            <div className="grid grid-cols-2 gap-4">
              <DayField
                label="First day"
                value={validFrom}
                onChange={setValidFrom}
                error={errors['validFrom']}
              />
              <DayField
                label="Last day"
                optional
                value={lastDay}
                onChange={setLastDay}
                error={errors['validTo']}
              />
            </div>
          </>
        )}
      </FormDialog>
      <ImportUsRatesDialog open={importing} onOpenChange={setImporting} />
      <EndRateDialog
        key={ending?.rate.id ?? 'none'}
        target={ending}
        onClose={() => {
          setEnding(undefined);
        }}
      />
      <DeleteRateDialog
        target={deleting}
        onClose={() => {
          setDeleting(undefined);
        }}
        onDeleted={() => router.invalidate()}
      />
    </Card>
  );
}

// Exemptions -----------------------------------------------------------------------------------

export function ExemptionsCard({
  exemptions,
  customers,
  manage,
  customerId,
}: {
  exemptions: readonly Exemption[];
  /** The customers to pick from and name; left out on a customer's own page. */
  customers?: readonly { value: string; label: string }[] | undefined;
  manage: boolean;
  /** Set on a customer's page: certificates are added for this customer. */
  customerId?: string;
}) {
  const website = useWebsite();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Exemption | undefined>();
  const [chosen, setChosen] = useState<string | null>(null);
  const [stateCode, setStateCode] = useState('');
  const [certificateNumber, setCertificateNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const names = new Map((customers ?? []).map((c) => [c.value, c.label]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tax exemption certificates</CardTitle>
        <span className="text-meta text-muted-foreground">
          A customer with a certificate for the ship-to state is charged no US sales tax.
        </span>
        {manage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setChosen(customerId ?? null);
              setStateCode('');
              setCertificateNumber('');
              setExpiresOn('');
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            Add certificate
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {exemptions.length === 0 ? (
          <p className="text-muted-foreground">No exemption certificates.</p>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                {customerId === undefined ? <TableHead>Customer</TableHead> : null}
                <TableHead>State</TableHead>
                <TableHead>Certificate</TableHead>
                <TableHead>Expires</TableHead>
                {manage ? <TableHead className="w-24" /> : null}
              </tr>
            </TableHeader>
            <TableBody>
              {exemptions.map((e) => (
                <TableRow key={e.id}>
                  {customerId === undefined ? (
                    <TableCell>
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: e.customerId }}
                        search={{}}
                      >
                        {names.get(e.customerId) ?? 'Customer'}
                      </Link>
                    </TableCell>
                  ) : null}
                  <TableCell>{stateName(e.stateCode)}</TableCell>
                  <TableCell className="font-mono text-[12.5px]">{e.certificateNumber}</TableCell>
                  <TableCell>
                    {e.expiresOn === null ? (
                      <span className="text-muted-foreground">No expiry</span>
                    ) : (
                      formatDay(e.expiresOn, website)
                    )}
                  </TableCell>
                  {manage ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRemoving(e);
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
      </CardContent>
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add an exemption certificate"
        description="One certificate per customer and state."
        submitLabel="Add certificate"
        success="Certificate added"
        onSubmit={() =>
          addExemption({
            customerId: chosen ?? '',
            stateCode,
            certificateNumber: certificateNumber.trim(),
            expiresOn: expiresOn || null,
          })
        }
      >
        {(errors) => (
          <>
            {customerId === undefined ? (
              <Field label="Customer" error={errors['customerId']}>
                {({ id }) => (
                  <Combobox
                    id={id}
                    value={chosen}
                    onChange={setChosen}
                    options={customers ?? []}
                    placeholder="Choose a customer"
                    searchLabel="Search customers"
                  />
                )}
              </Field>
            ) : null}
            <StateSelect value={stateCode} onChange={setStateCode} error={errors['stateCode']} />
            <Field label="Certificate number" error={errors['certificateNumber']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={100}
                  value={certificateNumber}
                  onChange={(event) => {
                    setCertificateNumber(event.target.value);
                  }}
                />
              )}
            </Field>
            <DayField
              label="Expires on"
              optional
              value={expiresOn}
              onChange={setExpiresOn}
              error={errors['expiresOn']}
            />
          </>
        )}
      </FormDialog>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(o) => {
          if (!o) setRemoving(undefined);
        }}
        title="Remove this certificate?"
        description="The customer is then charged sales tax in this state."
        confirmLabel="Remove certificate"
        onConfirm={async () => {
          if (removing) await deleteExemption(removing.id);
          await router.invalidate();
        }}
      />
    </Card>
  );
}

// The page -------------------------------------------------------------------------------------

function TaxPage() {
  const data = taxRoute.useLoaderData();
  const search = taxRoute.useSearch();
  const navigate = useNavigate({ from: '/tax' });
  const website = useWebsite();
  const manage = can(useSession(), 'tax.manage');
  const today = todayIn(website.timeZone);

  // The screen follows the website chosen in the top bar.
  useEffect(() => {
    if (website.id !== '' && search.website !== website.id) {
      void navigate({
        to: '.',
        search: (prev) => taxSearch({ ...prev, website: website.id }),
        replace: true,
      });
    }
  }, [search.website, website.id, navigate]);

  const setTab = (tab: TaxTab) => {
    void navigate({ to: '.', search: (prev) => taxSearch({ ...prev, tab }) });
  };

  const header = (
    <>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Tax' }]} />
      <PageHeader
        title="Tax"
        description={`What checkout charges on ${website.name}: registrations, rates and exemptions.`}
      />
    </>
  );
  if (website.id === '') {
    return (
      <Page>
        {header}
        <EmptyState
          icon={Receipt}
          title="No website yet"
          description="Tax is set up per website. Create a website first."
        />
      </Page>
    );
  }
  if (data?.readiness.websiteId !== website.id) return <Page>{header}</Page>;

  const { readiness, registrations } = data;
  const india = readiness.countryCode === 'IN';
  const tab = search.tab === 'exemptions' && india ? 'readiness' : (search.tab ?? 'readiness');
  const missing = readiness.items.filter((i) => !i.ok).length;

  return (
    <Page>
      {header}
      <Tabs
        value={tab}
        onValueChange={(next) => {
          setTab(next as TaxTab);
        }}
      >
        <TabsList aria-label="Tax sections">
          <TabsTrigger value="readiness">
            Readiness
            {missing > 0 ? <TabCount>{missing}</TabCount> : null}
          </TabsTrigger>
          <TabsTrigger value="registration">Registration</TabsTrigger>
          <TabsTrigger value="rates">Rates</TabsTrigger>
          {india ? null : <TabsTrigger value="exemptions">Exemptions</TabsTrigger>}
        </TabsList>
        <TabsContent value="readiness">
          <ReadinessTab readiness={readiness} onTab={setTab} />
        </TabsContent>
        <TabsContent value="registration">
          {india ? (
            <GstRegistrationCard
              key={registrations.find((r) => r.regime === 'gst')?.number ?? ''}
              websiteId={website.id}
              registration={registrations.find((r) => r.regime === 'gst')}
              manage={manage}
            />
          ) : (
            <UsPermitsCard
              websiteId={website.id}
              permits={registrations.filter((r) => r.regime === 'us_sales_tax')}
              manage={manage}
            />
          )}
        </TabsContent>
        <TabsContent value="rates">
          {'gstRates' in data ? (
            <GstRatesCard rates={data.gstRates} manage={manage} today={today} />
          ) : (
            <UsRatesCard rates={data.usRates} manage={manage} today={today} />
          )}
        </TabsContent>
        {'exemptions' in data ? (
          <TabsContent value="exemptions">
            <ExemptionsCard
              exemptions={data.exemptions}
              customers={data.customers}
              manage={manage}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </Page>
  );
}
