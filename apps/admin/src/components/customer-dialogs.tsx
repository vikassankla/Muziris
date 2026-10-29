import { useState, type SubmitEvent } from 'react';
import type { Customer, CustomerGroup } from '../lib/endpoints.js';
import { createCustomer, setCustomerGroup, setCustomerParent } from '../lib/endpoints.js';
import { fieldErrors } from '../lib/form.js';
import { useSubmit } from '../lib/use-submit.js';
import { Combobox, type ComboboxOption } from './combobox.js';
import { Field } from './field.js';
import { ProblemAlert } from './problem-view.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
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

const NO_GROUP = '__none';

export function groupOptions(groups: readonly CustomerGroup[]) {
  return groups.map((g) => ({ value: g.id, label: g.name, hint: g.code }));
}

export function customerOptions(
  customers: readonly Customer[],
  exclude?: string,
): ComboboxOption[] {
  return customers.filter((c) => c.id !== exclude).map((c) => ({ value: c.id, label: c.name }));
}

function GroupSelect({
  id,
  value,
  onChange,
  groups,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  groups: readonly CustomerGroup[];
}) {
  return (
    <Select
      value={value ?? NO_GROUP}
      onValueChange={(next) => {
        onChange(next === NO_GROUP ? null : next);
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_GROUP}>No customer group</SelectItem>
        {groups.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            {g.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** New customer, in a sheet (Customers board). A parent makes it a subsidiary. */
export function NewCustomerSheet({
  open,
  onOpenChange,
  groups,
  customers,
  parentId: initialParent = null,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CustomerGroup[];
  customers: readonly Customer[];
  parentId?: string | null;
  onCreated: (customer: Customer) => void;
}) {
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(initialParent);
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const customer = await submit(() => createCustomer({ name, groupId, parentId }), {
      title: 'Customer created',
      description: name,
    });
    if (customer) {
      setName('');
      onCreated(customer);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) setParentId(initialParent);
        else setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{initialParent ? 'Add subsidiary' : 'New customer'}</SheetTitle>
          <SheetDescription>You can add buyer users and addresses after saving.</SheetDescription>
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
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Customer group"
              optional
              hint="Customers in a group share price lists and settings."
            >
              {({ id }) => (
                <GroupSelect id={id} value={groupId} onChange={setGroupId} groups={groups} />
              )}
            </Field>
            <Field label="Parent customer" optional hint="Leave empty for a top-level customer.">
              {(props) => (
                <Combobox
                  id={props.id}
                  value={parentId}
                  onChange={setParentId}
                  options={customerOptions(customers)}
                  placeholder="None (top-level customer)"
                  emptyLabel="None (top-level customer)"
                  searchLabel="Search customers"
                />
              )}
            </Field>
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending}>
              Create customer
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Change a customer's customer group, or its parent customer, in a small dialog. */
export function ChangeCustomerDialog({
  customer,
  kind,
  open,
  onOpenChange,
  groups,
  customers,
}: {
  customer: Customer;
  kind: 'group' | 'parent';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CustomerGroup[];
  customers: readonly Customer[];
}) {
  const [value, setValue] = useState<string | null>(
    kind === 'group' ? customer.groupId : customer.parentId,
  );
  const { pending, problem, setProblem, submit } = useSubmit();
  const title = kind === 'group' ? 'Change customer group' : 'Set parent customer';

  async function save() {
    const saved = await submit(
      () =>
        kind === 'group'
          ? setCustomerGroup(customer.id, value)
          : setCustomerParent(customer.id, value),
      {
        title: kind === 'group' ? 'Customer group changed' : 'Parent customer changed',
        description: customer.name,
      },
    );
    if (saved) onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(kind === 'group' ? customer.groupId : customer.parentId);
        else setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{customer.name}</DialogDescription>
        </DialogHeader>
        {problem ? <ProblemAlert problem={problem} /> : null}
        {kind === 'group' ? (
          <Field label="Customer group">
            {({ id }) => <GroupSelect id={id} value={value} onChange={setValue} groups={groups} />}
          </Field>
        ) : (
          <Field
            label="Parent customer"
            hint="A customer cannot move under itself or its subsidiaries."
          >
            {(props) => (
              <Combobox
                id={props.id}
                value={value}
                onChange={setValue}
                options={customerOptions(customers, customer.id)}
                placeholder="None (top-level customer)"
                emptyLabel="None (top-level customer)"
                searchLabel="Search customers"
              />
            )}
          </Field>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
