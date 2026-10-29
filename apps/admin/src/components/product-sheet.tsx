import { useState, type SubmitEvent } from 'react';
import { createProduct, type ProductUnit, type Product } from '../lib/endpoints.js';
import type { FlatCategory } from '../lib/categories.js';
import { fieldErrors } from '../lib/form.js';
import { useSubmit } from '../lib/use-submit.js';
import { Combobox } from './combobox.js';
import { Field } from './field.js';
import { ProblemAlert } from './problem-view.js';
import { Alert } from './ui/alert.js';
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
import { Switch } from './ui/switch.js';

/** New product: SKU, name, category, primary product unit and status. */
export function NewProductSheet({
  open,
  onOpenChange,
  categories,
  units,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: readonly FlatCategory[];
  units: readonly ProductUnit[];
  onCreated: (product: Product) => void;
}) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [unit, setUnit] = useState(units[0]?.code ?? '');
  const [enabled, setEnabled] = useState(false);
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const skuError =
    problem?.code === 'sku_taken' ? 'Another product already uses this SKU.' : errors['sku'];

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const product = await submit(
      () =>
        createProduct({
          sku,
          name,
          categoryId,
          primaryUnitCode: unit,
          status: enabled ? 'enabled' : 'disabled',
        }),
      { title: 'Product created', description: sku },
    );
    if (product) onCreated(product);
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
          <SheetTitle>New product</SheetTitle>
          <SheetDescription>Add more product units and attributes after saving.</SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            {units.length === 0 ? (
              <Alert variant="warning">
                Create a product unit first. Every product needs a primary product unit.
              </Alert>
            ) : null}
            {problem && problem.code !== 'validation_failed' && problem.code !== 'sku_taken' ? (
              <ProblemAlert problem={problem} />
            ) : null}
            <Field
              label="SKU"
              hint="Unique across the catalog. Buyers use it in quick order."
              error={skuError}
            >
              {(props) => (
                <Input
                  {...props}
                  required
                  className="font-mono"
                  maxLength={64}
                  value={sku}
                  onChange={(e) => {
                    setSku(e.target.value);
                  }}
                />
              )}
            </Field>
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
            <Field label="Category" optional>
              {({ id }) => (
                <Combobox
                  id={id}
                  value={categoryId}
                  onChange={setCategoryId}
                  options={categories.map((c) => ({ value: c.node.id, label: c.path }))}
                  placeholder="No category"
                  emptyLabel="No category"
                  searchLabel="Search categories"
                />
              )}
            </Field>
            <Field label="Primary product unit" error={errors['primaryUnitCode']}>
              {({ id }) => (
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger id={id}>
                    <SelectValue placeholder="Choose a product unit" />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((u) => (
                      <SelectItem key={u.code} value={u.code}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <div className="flex items-center gap-2.5">
              <Switch id="new-product-status" checked={enabled} onCheckedChange={setEnabled} />
              <label htmlFor="new-product-status">{enabled ? 'Enabled' : 'Disabled'}</label>
              <span className="text-meta text-muted-foreground">
                {enabled ? 'Buyers can find and order it.' : 'Hidden from buyers until enabled.'}
              </span>
            </div>
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending || units.length === 0}>
              Create product
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
