import { createRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { EyeOff, Plus, ScanEye, Trash2 } from 'lucide-react';
import { useEffect, useState, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { Combobox } from '../components/combobox.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { ProductPicker } from '../components/pricing.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
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
  subjectLabel,
  SUBJECT_LABELS,
  TARGET_LABELS,
  targetLabel,
  VisibilityBadge,
  VisibilityBuildBanner,
  VISIBILITY_LABELS,
} from '../components/visibility.js';
import { isApiProblem, type ApiProblem } from '../lib/api.js';
import { flattenCategories } from '../lib/categories.js';
import {
  createVisibilityRule,
  deleteVisibilityRule,
  getVisibilityBuild,
  listCategories,
  listCustomerGroups,
  listCustomers,
  listVisibilityRules,
  previewVisibility,
  RULE_SUBJECTS,
  RULE_TARGETS,
  updateVisibilityRule,
  type CategoryNode,
  type Customer,
  type CustomerGroup,
  type Product,
  type RuleSubject,
  type RuleTarget,
  type Visibility,
  type VisibilityPreview,
  type VisibilityRule,
} from '../lib/endpoints.js';
import { formatDateTime } from '../lib/format.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// Visibility (ADR 0027): the rules that decide which products and categories each buyer sees on
// the website chosen in the top bar, the build banner, and a check of one buyer's view.

interface VisibilitySearch extends ListSearch {
  /** The website the screen shows; kept in step with the top bar. */
  website?: string;
  q?: string;
  subject?: RuleSubject;
  target?: RuleTarget;
  /** From the product page: the rules on one product. */
  subjectId?: string;
  /** From the customer page: the rules for one customer. */
  targetId?: string;
}

const ANY = '__any';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : undefined;
}

function visibilitySearch(search: Record<string, unknown>): VisibilitySearch {
  const out: VisibilitySearch = listSearch(search);
  const website = text(search['website']);
  if (website !== undefined) out.website = website;
  const q = text(search['q']);
  if (q !== undefined) out.q = q;
  const subject = search['subject'];
  if ((RULE_SUBJECTS as readonly unknown[]).includes(subject)) {
    out.subject = subject as RuleSubject;
  }
  const target = search['target'];
  if ((RULE_TARGETS as readonly unknown[]).includes(target)) out.target = target as RuleTarget;
  const subjectId = text(search['subjectId']);
  if (subjectId !== undefined) out.subjectId = subjectId;
  const targetId = text(search['targetId']);
  if (targetId !== undefined) out.targetId = targetId;
  return out;
}

export const visibilityRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/visibility',
  validateSearch: visibilitySearch,
  loaderDeps: ({ search }) => ({
    website: search.website,
    after: search.after,
    limit: search.limit,
    q: search.q,
    subject: search.subject,
    target: search.target,
    subjectId: search.subjectId,
    targetId: search.targetId,
  }),
  loader: async ({ deps, abortController }) => {
    const { website, ...query } = deps;
    if (website === undefined) return undefined;
    const signal = abortController.signal;
    const [rules, build] = await Promise.all([
      listVisibilityRules({ websiteId: website, ...query }, signal),
      getVisibilityBuild(signal),
    ]);
    return { websiteId: website, rules, build };
  },
  component: VisibilityPage,
});

/** Customers, customer groups and categories for the pickers, loaded when a sheet opens. */
function usePickerData(open: boolean) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const signal = controller.signal;
    listCustomers({ limit: 200 }, signal)
      .then((page) => {
        setCustomers(page.items);
      })
      .catch(() => undefined);
    listCustomerGroups(undefined, signal)
      .then((page) => {
        setGroups(page.items);
      })
      .catch(() => undefined);
    listCategories(signal)
      .then(setCategories)
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [open]);
  return { customers, groups, categories: flattenCategories(categories) };
}

/** A product picked by SKU or name, or a category from the tree. */
function SubjectFields({
  subject,
  onSubject,
  product,
  onProduct,
  categoryId,
  onCategory,
  categories,
}: {
  subject: RuleSubject;
  onSubject: (subject: RuleSubject) => void;
  product: Product | undefined;
  onProduct: (product: Product | undefined) => void;
  categoryId: string | null;
  onCategory: (id: string | null) => void;
  categories: ReturnType<typeof usePickerData>['categories'];
}) {
  return (
    <>
      <Field label="Rule on">
        {({ id }) => (
          <Select
            value={subject}
            onValueChange={(next) => {
              onSubject(next as RuleSubject);
            }}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="product">A product</SelectItem>
              <SelectItem value="category">A category and everything in it</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Field>
      {subject === 'product' ? (
        <Field label="Product">
          {({ id }) => <ProductPicker id={id} product={product} onProduct={onProduct} />}
        </Field>
      ) : (
        <Field label="Category">
          {({ id }) => (
            <Combobox
              id={id}
              value={categoryId}
              onChange={onCategory}
              options={categories.map((c) => ({ value: c.node.id, label: c.path }))}
              placeholder="Choose a category"
              searchLabel="Search categories"
            />
          )}
        </Field>
      )}
    </>
  );
}

function NewRuleSheet({
  open,
  onOpenChange,
  websiteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  websiteId: string;
}) {
  const website = useWebsite();
  const { customers, groups, categories } = usePickerData(open);
  const [subject, setSubject] = useState<RuleSubject>('product');
  const [product, setProduct] = useState<Product | undefined>();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [target, setTarget] = useState<RuleTarget>('customer_group');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('hidden');
  const [existing, setExisting] = useState<VisibilityRule | undefined>();
  const { pending, problem, setProblem, submit } = useSubmit();

  const subjectId = subject === 'product' ? product?.id : (categoryId ?? undefined);
  const ready = subjectId !== undefined && (target === 'website' || targetId !== null);

  function reset() {
    setProduct(undefined);
    setCategoryId(null);
    setTargetId(null);
    setExisting(undefined);
    setProblem(undefined);
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setExisting(undefined);
    const created = await submit(
      () =>
        createVisibilityRule({
          websiteId,
          subject,
          subjectId,
          target,
          ...(target === 'website' || targetId === null ? {} : { targetId }),
          visibility,
        }),
      { title: 'Visibility rule created' },
    );
    if (created) {
      reset();
      onOpenChange(false);
    }
  }

  // One rule per subject and target: on a refusal, find that rule so it can be changed instead.
  useEffect(() => {
    if (problem?.code !== 'rule_taken' || subjectId === undefined) return;
    const controller = new AbortController();
    listVisibilityRules(
      {
        websiteId,
        subjectId,
        target,
        targetId: target === 'website' ? websiteId : (targetId ?? undefined),
        limit: 25,
      },
      controller.signal,
    )
      .then((page) => {
        setExisting(page.items[0]);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [problem, subjectId, target, targetId, websiteId]);

  async function changeExisting(rule: VisibilityRule) {
    const changed = await submit(() => updateVisibilityRule(rule.id, visibility), {
      title: 'Visibility rule changed',
    });
    if (changed !== undefined) {
      reset();
      onOpenChange(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New visibility rule</SheetTitle>
          <SheetDescription>
            On {website.name}. Buyers see the change after the next visibility build, which the rule
            queues.
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            <SubjectFields
              subject={subject}
              onSubject={(next) => {
                setSubject(next);
                setExisting(undefined);
                setProblem(undefined);
              }}
              product={product}
              onProduct={setProduct}
              categoryId={categoryId}
              onCategory={setCategoryId}
              categories={categories}
            />
            <Field label="For">
              {({ id }) => (
                <Select
                  value={target}
                  onValueChange={(next) => {
                    setTarget(next as RuleTarget);
                    setTargetId(null);
                    setExisting(undefined);
                    setProblem(undefined);
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="website">Everyone on {website.name}</SelectItem>
                    <SelectItem value="customer_group">A customer group</SelectItem>
                    <SelectItem value="customer">A customer</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {target === 'customer_group' ? (
              <Field label="Customer group">
                {({ id }) => (
                  <Combobox
                    id={id}
                    value={targetId}
                    onChange={setTargetId}
                    options={groups.map((g) => ({ value: g.id, label: g.name }))}
                    placeholder="Choose a customer group"
                    searchLabel="Search customer groups"
                  />
                )}
              </Field>
            ) : null}
            {target === 'customer' ? (
              <Field label="Customer" hint="The first 200 customers, by name.">
                {({ id }) => (
                  <Combobox
                    id={id}
                    value={targetId}
                    onChange={setTargetId}
                    options={customers.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder="Choose a customer"
                    searchLabel="Search customers"
                  />
                )}
              </Field>
            ) : null}
            <Field label="Visibility">
              {({ id }) => (
                <Select
                  value={visibility}
                  onValueChange={(next) => {
                    setVisibility(next as Visibility);
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hidden">Hidden</SelectItem>
                    <SelectItem value="visible">Visible</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {problem?.code === 'rule_taken' ? (
              <Alert variant="warning">
                <div className="flex flex-col gap-2">
                  <span>
                    {existing
                      ? `This already has a rule for ${targetLabel(existing)}: ${VISIBILITY_LABELS[existing.visibility]}.`
                      : problem.title}
                  </span>
                  {existing && existing.visibility !== visibility ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="self-start"
                      disabled={pending}
                      onClick={() => void changeExisting(existing)}
                    >
                      Change that rule to {VISIBILITY_LABELS[visibility]}
                    </Button>
                  ) : null}
                </div>
              </Alert>
            ) : problem ? (
              <ProblemAlert problem={problem} />
            ) : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending || !ready}>
              Create rule
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

const SERVED_FROM: Record<string, string> = {
  customer: 'the customer’s own rules',
  customer_group: 'its customer group’s rules',
  website: 'the website’s rules',
  default: 'no rules: everything enabled is visible',
};

/** The preview's answer in words (ADR 0027). */
export function PreviewAnswer({ preview }: { preview: VisibilityPreview }) {
  const word = preview.visible ? 'Visible' : 'Hidden';
  const why =
    preview.reason === 'disabled'
      ? 'Hidden: it is disabled in the catalog.'
      : preview.reason === 'default' || preview.rule === null
        ? 'No rule: visible by default.'
        : `${word} by the rule on ${subjectLabel(preview.rule)} for ${targetLabel(preview.rule)}${
            preview.categoryDistance ? ', a category above it' : ''
          }.`;
  const built = preview.built;
  return (
    <section aria-label="What the buyer sees" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-md border border-border p-3">
        <span className="text-meta text-muted-foreground">From the rules as they are now</span>
        <span>
          <VisibilityBadge visibility={preview.visible ? 'visible' : 'hidden'} />
        </span>
        <span className="text-meta">{why}</span>
      </div>
      {built.needsRebuild ? (
        <Alert variant="warning">
          The customer changed customer group since the last build, so buyers see nothing until the
          next visibility build.
        </Alert>
      ) : built.context === null ? (
        <Alert variant="warning">No visibility build has run yet, so buyers see no products.</Alert>
      ) : (
        <span className="text-meta">
          The last build gives buyers: {built.visible ? 'visible' : 'hidden'}, from{' '}
          {SERVED_FROM[built.context]}.
        </span>
      )}
      {!built.needsRebuild && built.context !== null && built.visible !== preview.visible ? (
        <Alert variant="info">The change waits for a visibility build.</Alert>
      ) : null}
    </section>
  );
}

function CheckViewSheet({
  open,
  onOpenChange,
  websiteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  websiteId: string;
}) {
  const website = useWebsite();
  const { customers, categories } = usePickerData(open);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [subject, setSubject] = useState<RuleSubject>('product');
  const [product, setProduct] = useState<Product | undefined>();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [preview, setPreview] = useState<VisibilityPreview | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [pending, setPending] = useState(false);
  const subjectId = subject === 'product' ? product?.id : (categoryId ?? undefined);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerId || subjectId === undefined) return;
    setPending(true);
    setProblem(undefined);
    try {
      setPreview(
        await previewVisibility(
          subject === 'product'
            ? { websiteId, customerId, productId: subjectId }
            : { websiteId, customerId, categoryId: subjectId },
        ),
      );
    } catch (error) {
      setPreview(undefined);
      if (isApiProblem(error)) setProblem(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Check a buyer’s view</SheetTitle>
          <SheetDescription>
            Whether buyers of a customer see a product or a category on {website.name}, and which
            rule decides.
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            <Field label="Customer" hint="The first 200 customers, by name.">
              {({ id }) => (
                <Combobox
                  id={id}
                  value={customerId}
                  onChange={(next) => {
                    setCustomerId(next);
                    setPreview(undefined);
                  }}
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Choose a customer"
                  searchLabel="Search customers"
                />
              )}
            </Field>
            <SubjectFields
              subject={subject}
              onSubject={(next) => {
                setSubject(next);
                setPreview(undefined);
              }}
              product={product}
              onProduct={(next) => {
                setProduct(next);
                setPreview(undefined);
              }}
              categoryId={categoryId}
              onCategory={(next) => {
                setCategoryId(next);
                setPreview(undefined);
              }}
              categories={categories}
            />
            {problem ? <ProblemAlert problem={problem} /> : null}
            {preview ? <PreviewAnswer preview={preview} /> : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Close</Button>
            </SheetClose>
            <Button type="submit" disabled={pending || !customerId || subjectId === undefined}>
              Check
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function RuleActions({ rule }: { rule: VisibilityRule }) {
  const router = useRouter();
  const { pending, submit } = useSubmit();
  const [confirming, setConfirming] = useState(false);
  const next: Visibility = rule.visibility === 'visible' ? 'hidden' : 'visible';
  return (
    <div className="flex justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={`Make ${VISIBILITY_LABELS[next].toLowerCase()}: ${subjectLabel(rule)} for ${targetLabel(rule)}`}
        onClick={() => {
          void submit(() => updateVisibilityRule(rule.id, next), {
            title: `Rule changed to ${VISIBILITY_LABELS[next]}`,
          });
        }}
      >
        {next === 'hidden' ? 'Hide' : 'Make visible'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Delete the rule on ${subjectLabel(rule)} for ${targetLabel(rule)}`}
        onClick={() => {
          setConfirming(true);
        }}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this rule?"
        description={`${subjectLabel(rule)} for ${targetLabel(rule)}. Without it, the next rule up decides, or the product is visible by default.`}
        confirmLabel="Delete rule"
        onConfirm={async () => {
          await deleteVisibilityRule(rule.id);
          toast.success('Visibility rule deleted');
          await router.invalidate();
        }}
      />
    </div>
  );
}

function VisibilityPage() {
  const data = visibilityRoute.useLoaderData();
  const search = visibilityRoute.useSearch();
  const navigate = useNavigate({ from: '/visibility' });
  const website = useWebsite();
  const manage = can(useSession(), 'visibility.manage');
  const [query, setQuery] = useState(search.q ?? '');
  const [checking, setChecking] = useState(false);

  // The screen follows the website chosen in the top bar.
  useEffect(() => {
    if (website.id !== '' && search.website !== website.id) {
      void navigate({
        to: '.',
        search: (prev) => {
          const next = visibilitySearch({ ...prev, website: website.id });
          delete next.after;
          return next;
        },
        replace: true,
      });
    }
  }, [search.website, website.id, navigate]);

  const setSearch = (change: {
    [K in keyof VisibilitySearch]?: VisibilitySearch[K] | undefined;
  }) => {
    void navigate({
      to: '.',
      search: (prev) => {
        const next = visibilitySearch({ ...prev, ...change });
        delete next.after;
        return next;
      },
    });
  };
  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew(open) });
  };

  const newButton = manage ? (
    <Button
      onClick={() => {
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New rule
    </Button>
  ) : null;
  const header = (
    <>
      <Breadcrumbs crumbs={[{ label: 'Catalog' }, { label: 'Visibility' }]} />
      <PageHeader
        title="Visibility"
        description={`Which products and categories buyers see on ${website.name}. The nearest rule decides: customer, then customer group, then the website; a product's own rule beats its category's. Without a rule, everything enabled is visible.`}
        actions={
          website.id === '' ? undefined : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setChecking(true);
                }}
              >
                <ScanEye aria-hidden="true" />
                Check a buyer’s view
              </Button>
              {newButton}
            </>
          )
        }
      />
    </>
  );
  if (website.id === '') {
    return (
      <Page>
        {header}
        <EmptyState
          icon={EyeOff}
          title="No website yet"
          description="Visibility rules are set per website. Create a website first."
        />
      </Page>
    );
  }
  if (data?.websiteId !== website.id) return <Page>{header}</Page>;

  const { rules, build } = data;
  const filtered =
    search.q !== undefined ||
    search.subject !== undefined ||
    search.target !== undefined ||
    search.subjectId !== undefined ||
    search.targetId !== undefined;
  const narrowedTo =
    search.subjectId !== undefined
      ? rules.items.find((r) => r.subjectId === search.subjectId)
      : search.targetId !== undefined
        ? rules.items.find((r) => r.targetId === search.targetId)
        : undefined;

  return (
    <Page>
      {header}
      <VisibilityBuildBanner build={build} manage={manage} />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch({ q: query.trim() || undefined });
        }}
      >
        <Field label="Search rules" className="w-72">
          {(props) => (
            <Input
              {...props}
              type="search"
              placeholder="SKU, product, category, customer or group"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Rule on" className="w-44">
          {({ id }) => (
            <Select
              value={search.subject ?? ANY}
              onValueChange={(next) => {
                setSearch({ subject: next === ANY ? undefined : (next as RuleSubject) });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Products and categories</SelectItem>
                <SelectItem value="product">Products</SelectItem>
                <SelectItem value="category">Categories</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="For" className="w-52">
          {({ id }) => (
            <Select
              value={search.target ?? ANY}
              onValueChange={(next) => {
                setSearch({ target: next === ANY ? undefined : (next as RuleTarget) });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Anyone</SelectItem>
                {RULE_TARGETS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TARGET_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Button type="submit" variant="outline">
          Search
        </Button>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery('');
              void navigate({ to: '.', search: { website: website.id } });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </form>
      {narrowedTo ? (
        <p className="text-meta text-muted-foreground">
          Showing the rules{' '}
          {search.subjectId !== undefined
            ? `on ${subjectLabel(narrowedTo)}`
            : `for ${targetLabel(narrowedTo)}`}
          .
        </p>
      ) : null}
      {rules.items.length === 0 ? (
        <EmptyState
          icon={EyeOff}
          title={filtered ? 'No rules match' : 'No visibility rules yet'}
          description={
            filtered
              ? 'Try another search or filter.'
              : 'Every enabled product is visible to every buyer on this website. Add a rule to hide a product or category from a customer or customer group.'
          }
          action={filtered ? undefined : (newButton ?? undefined)}
        />
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Subject</TableHead>
              <TableHead>For</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>Changed</TableHead>
              {manage ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </tr>
          </TableHeader>
          <TableBody>
            {rules.items.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-semibold">{subjectLabel(rule)}</span>
                    <span className="text-meta text-muted-foreground">
                      {SUBJECT_LABELS[rule.subject]}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{targetLabel(rule)}</span>
                    {rule.target === 'website' ? null : (
                      <span className="text-meta text-muted-foreground">
                        {TARGET_LABELS[rule.target]}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <VisibilityBadge visibility={rule.visibility} />
                </TableCell>
                <TableCell>{formatDateTime(rule.updatedAt, website)}</TableCell>
                {manage ? (
                  <TableCell>
                    <RuleActions rule={rule} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager
        after={search.after}
        nextAfter={rules.nextAfter}
        limit={search.limit}
        shown={rules.items.length}
        noun="rules"
      />
      {manage ? (
        <NewRuleSheet open={search.new === true} onOpenChange={setNew} websiteId={website.id} />
      ) : null}
      <CheckViewSheet open={checking} onOpenChange={setChecking} websiteId={website.id} />
    </Page>
  );
}
