import { createRoute, useBlocker } from '@tanstack/react-router';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '../components/combobox.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { Alert } from '../components/ui/alert.js';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { Badge, PlannedTag, Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Kbd } from '../components/ui/misc.js';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Switch } from '../components/ui/switch.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { flattenCategories } from '../lib/categories.js';
import {
  getProduct,
  listCategories,
  listProductUnits,
  setProductUnits,
  updateProduct,
  type AttributeValue,
  type Product,
} from '../lib/endpoints.js';
import { formatDateTime, formatQuantity } from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

export const productDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/products/$productId',
  loader: async ({ params, abortController }) => {
    const signal = abortController.signal;
    const [product, categories, units] = await Promise.all([
      getProduct(params.productId, signal),
      listCategories(signal),
      listProductUnits(signal),
    ]);
    return { product, categories: flattenCategories(categories), units };
  },
  component: ProductDetailPage,
});

const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,62}$/;

interface AttributeRow {
  id: number;
  key: string;
  /** Text as edited; lists are shown joined by ", ". */
  text: string;
  /** The stored value, kept as it was when the text is not touched (true/false, lists). */
  original: AttributeValue | undefined;
}

interface Draft {
  sku: string;
  name: string;
  status: Product['status'];
  categoryId: string | null;
  primaryUnitCode: string;
  unitCodes: string[];
  attributes: AttributeRow[];
}

function textOf(value: AttributeValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function draftOf(product: Product): Draft {
  return {
    sku: product.sku,
    name: product.name,
    status: product.status,
    categoryId: product.categoryId,
    primaryUnitCode: product.primaryUnitCode,
    unitCodes: product.units.map((u) => u.code),
    attributes: Object.entries(product.attributes).map(([key, value], index) => ({
      id: index,
      key,
      text: textOf(value),
      original: value,
    })),
  };
}

function attributesOf(rows: readonly AttributeRow[]): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const row of rows) {
    if (row.key === '') continue;
    out[row.key] =
      row.original !== undefined && textOf(row.original) === row.text
        ? row.original
        : row.text.trim();
  }
  return out;
}

/** Which parts of the draft differ from the product, as the API calls that would save them. */
function changesOf(product: Product, draft: Draft) {
  const general: Parameters<typeof updateProduct>[1] = {};
  if (draft.sku !== product.sku) general.sku = draft.sku;
  if (draft.name !== product.name) general.name = draft.name;
  if (draft.status !== product.status) general.status = draft.status;
  if (draft.categoryId !== product.categoryId) general.categoryId = draft.categoryId;
  const attributes = attributesOf(draft.attributes);
  if (JSON.stringify(attributes) !== JSON.stringify(product.attributes))
    general.attributes = attributes;
  const before = product.units.map((u) => u.code);
  const unitsChanged =
    draft.primaryUnitCode !== product.primaryUnitCode ||
    draft.unitCodes.length !== before.length ||
    draft.unitCodes.some((code) => !before.includes(code));
  return { general, unitsChanged, count: Object.keys(general).length + (unitsChanged ? 1 : 0) };
}

/** Problems the form can see before saving: empty or repeated attribute keys, bad key shape. */
function attributeErrors(rows: readonly AttributeRow[]): Map<number, string> {
  const errors = new Map<number, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.key === '' && row.text === '') continue;
    if (!ATTRIBUTE_KEY.test(row.key)) {
      errors.set(row.id, 'Use lowercase letters, digits or _ for the key, starting with a letter.');
    } else if (seen.has(row.key)) {
      errors.set(row.id, `Key "${row.key}" is already used on this product.`);
    } else if (row.text.trim() === '') {
      errors.set(row.id, 'Give the attribute a value, or remove it.');
    }
    seen.add(row.key);
  }
  return errors;
}

function ProductDetailPage() {
  const { product, categories, units } = productDetailRoute.useLoaderData();
  const session = useSession();
  const website = useWebsite();
  const manage = can(session, 'product.manage');
  const [draft, setDraft] = useState<Draft>(() => draftOf(product));
  const [loadedAt, setLoadedAt] = useState(product.updatedAt);
  const [newUnit, setNewUnit] = useState('');
  const nextId = useRef(1000);
  const save = useSubmit();
  const unitSave = useSubmit();

  // A fresh product from the API (after saving) resets the draft.
  if (product.updatedAt !== loadedAt) {
    setLoadedAt(product.updatedAt);
    setDraft(draftOf(product));
  }

  const changes = changesOf(product, draft);
  const dirty = changes.count > 0;
  const attrErrors = attributeErrors(draft.attributes);
  const errors = fieldErrors(save.problem);
  const skuError =
    save.problem?.code === 'sku_taken' ? 'Another product already uses this SKU.' : errors['sku'];
  const path = categories.find((c) => c.node.id === product.categoryId)?.path;
  const set = (changes: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...changes }));
  };

  async function handleSave() {
    if (attrErrors.size > 0) return;
    const { general, unitsChanged } = changesOf(product, draft);
    if (Object.keys(general).length > 0) {
      const saved = await save.submit(() => updateProduct(product.id, general));
      if (!saved) return;
    }
    if (unitsChanged) {
      const saved = await unitSave.submit(() =>
        setProductUnits(product.id, {
          primaryUnitCode: draft.primaryUnitCode,
          additionalUnitCodes: draft.unitCodes.filter((c) => c !== draft.primaryUnitCode),
        }),
      );
      if (!saved) return;
    }
    toast.success('Product saved', { description: draft.sku });
  }

  const saveRef = useRef(handleSave);
  useEffect(() => {
    saveRef.current = handleSave;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  const unitByCode = new Map(units.map((u) => [u.code, u]));
  const addable = units.filter((u) => !draft.unitCodes.includes(u.code));

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Products', to: '/products' }, { label: product.sku }]} />
      <PageHeader
        title={product.name}
        badges={
          <>
            <Badge variant={product.status === 'enabled' ? 'success' : 'neutral'}>
              {product.status === 'enabled' ? 'Enabled' : 'Disabled'}
            </Badge>
            <Tag>{product.type === 'simple' ? 'Simple' : product.type}</Tag>
          </>
        }
        description={
          <>
            <span className="font-mono">{product.sku}</span>
            {path ? ` · ${path}` : ''} · updated {formatDateTime(product.updatedAt, website)}
          </>
        }
      />
      {dirty && manage ? (
        <Alert variant="warning" icon={<AlertTriangle />} className="items-center" role="status">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              <span className="font-semibold">Unsaved changes.</span> {changes.count}{' '}
              {changes.count === 1 ? 'part' : 'parts'} changed. Leaving this page will ask you to
              confirm.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(draftOf(product));
                save.setProblem(undefined);
                unitSave.setProblem(undefined);
              }}
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={save.pending || unitSave.pending}
              onClick={() => void handleSave()}
            >
              Save{' '}
              <Kbd className="ml-1 border-current bg-transparent text-inherit opacity-70">
                Ctrl S
              </Kbd>
            </Button>
          </div>
        </Alert>
      ) : null}
      {save.problem &&
      save.problem.code !== 'validation_failed' &&
      save.problem.code !== 'sku_taken' ? (
        <ProblemAlert problem={save.problem} />
      ) : null}
      {unitSave.problem ? <ProblemAlert problem={unitSave.problem} /> : null}

      <Tabs value="general">
        <TabsList aria-label="Product sections">
          <TabsTrigger value="general">General</TabsTrigger>
          {['Prices', 'Visibility', 'Images', 'Inventory'].map((label) => (
            <TabsTrigger key={label} value={label} disabled>
              {label} <PlannedTag />
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Field
            label="SKU"
            hint="Unique across the catalog. Buyers use it in quick order."
            error={skuError}
          >
            {(props) => (
              <Input
                {...props}
                className="font-mono"
                maxLength={64}
                disabled={!manage}
                value={draft.sku}
                onChange={(e) => {
                  set({ sku: e.target.value });
                }}
              />
            )}
          </Field>
          <Field label="Category" error={errors['categoryId']}>
            {({ id }) => (
              <Combobox
                id={id}
                value={draft.categoryId}
                onChange={(categoryId) => {
                  set({ categoryId });
                }}
                options={categories.map((c) => ({ value: c.node.id, label: c.path }))}
                placeholder="No category"
                emptyLabel="No category"
                searchLabel="Search categories"
                disabled={!manage}
              />
            )}
          </Field>
          <Field label="Name" className="col-span-2" error={errors['name']}>
            {(props) => (
              <Input
                {...props}
                maxLength={200}
                disabled={!manage}
                value={draft.name}
                onChange={(e) => {
                  set({ name: e.target.value });
                }}
              />
            )}
          </Field>
          <div className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[13px] font-[550]" id="status-label">
              Status
            </span>
            <div className="flex items-center gap-2.5">
              <Switch
                aria-labelledby="status-label"
                disabled={!manage}
                checked={draft.status === 'enabled'}
                onCheckedChange={(on) => {
                  set({ status: on ? 'enabled' : 'disabled' });
                }}
              />
              <span>{draft.status === 'enabled' ? 'Enabled' : 'Disabled'}</span>
              <span className="text-meta text-muted-foreground">
                {draft.status === 'enabled'
                  ? 'Buyers can find and order this product.'
                  : 'Hidden from buyers.'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Product units</CardTitle>
          <span className="text-meta text-muted-foreground">The units this product is sold in</span>
          <span className="flex-1" />
          {manage && addable.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select value={newUnit} onValueChange={setNewUnit}>
                <SelectTrigger size="sm" className="w-[160px]" aria-label="Product unit to add">
                  <SelectValue placeholder="Choose a unit" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((u) => (
                    <SelectItem key={u.code} value={u.code}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={newUnit === ''}
                onClick={() => {
                  set({ unitCodes: [...draft.unitCodes, newUnit] });
                  setNewUnit('');
                }}
              >
                <Plus aria-hidden="true" />
                Add product unit
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <RadioGroup
          value={draft.primaryUnitCode}
          onValueChange={(primaryUnitCode) => {
            set({ primaryUnitCode });
          }}
          disabled={!manage}
          aria-label="Primary product unit"
          className="block"
        >
          <Table bare>
            <TableHeader>
              <tr>
                <TableHead>Primary</TableHead>
                <TableHead>Product unit</TableHead>
                <TableHead>Precision</TableHead>
                <TableHead>Shown as</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {draft.unitCodes.map((code) => {
                const unit = unitByCode.get(code) ?? { code, name: code, precision: 0 };
                const primary = code === draft.primaryUnitCode;
                return (
                  <TableRow key={code}>
                    <TableCell>
                      <RadioGroupItem
                        value={code}
                        aria-label={
                          primary
                            ? `${unit.name} is the primary product unit`
                            : `Make ${unit.name} primary`
                        }
                      />
                    </TableCell>
                    <TableCell className="font-semibold">{unit.name}</TableCell>
                    <TableCell className="num">{unit.precision}</TableCell>
                    <TableCell className="num">
                      {formatQuantity(unit.precision > 0 ? '2' : '1250', unit, website)}
                    </TableCell>
                    <TableCell className="text-right">
                      {manage ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${unit.name}`}
                          disabled={primary}
                          onClick={() => {
                            set({ unitCodes: draft.unitCodes.filter((c) => c !== code) });
                          }}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </RadioGroup>
        <CardContent className="border-t text-meta text-muted-foreground">
          The primary product unit cannot be removed. Choose another primary first.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attributes</CardTitle>
          <span className="text-meta text-muted-foreground">
            Free key-value pairs today; a structured attribute form comes later
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex gap-2 text-xs font-semibold text-muted-foreground">
            <span className="flex-1">Key</span>
            <span className="flex-[2]">Value</span>
            <span className="w-7" />
          </div>
          {draft.attributes.map((row) => {
            const error = attrErrors.get(row.id);
            return (
              <div key={row.id} className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <Input
                    inputSize="sm"
                    className="flex-1 font-mono"
                    aria-label="Attribute key"
                    aria-invalid={error ? true : undefined}
                    disabled={!manage}
                    value={row.key}
                    onChange={(e) => {
                      set({
                        attributes: draft.attributes.map((r) =>
                          r.id === row.id ? { ...r, key: e.target.value } : r,
                        ),
                      });
                    }}
                  />
                  <Input
                    inputSize="sm"
                    className="flex-[2]"
                    aria-label={`Value for ${row.key || 'new attribute'}`}
                    disabled={!manage}
                    value={row.text}
                    onChange={(e) => {
                      set({
                        attributes: draft.attributes.map((r) =>
                          r.id === row.id ? { ...r, text: e.target.value } : r,
                        ),
                      });
                    }}
                  />
                  {manage ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove attribute ${row.key}`}
                      onClick={() => {
                        set({ attributes: draft.attributes.filter((r) => r.id !== row.id) });
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                {error ? <span className="text-meta text-destructive-text">{error}</span> : null}
              </div>
            );
          })}
          {errors['attributes'] ? (
            <span className="text-meta text-destructive-text">{errors['attributes']}</span>
          ) : null}
          {manage ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => {
                nextId.current += 1;
                set({
                  attributes: [
                    ...draft.attributes,
                    { id: nextId.current, key: '', text: '', original: undefined },
                  ],
                });
              }}
            >
              <Plus aria-hidden="true" />
              Add attribute
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog open={blocker.status === 'blocked'}>
        <AlertDialogContent>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            You changed {changes.count} {changes.count === 1 ? 'part' : 'parts'} of {product.sku}.
            If you leave now, those changes are lost.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => blocker.proceed?.()}>
              Discard and leave
            </Button>
            <Button onClick={() => blocker.reset?.()}>Keep editing</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
