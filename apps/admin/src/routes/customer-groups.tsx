import { createRoute, useNavigate } from '@tanstack/react-router';
import { Plus, Users } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { PlannedTag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
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
import { createCustomerGroup, listCustomerGroups, PAGE_SIZE } from '../lib/endpoints.js';
import { CODE_HINT, CODE_PATTERN, fieldErrors } from '../lib/form.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { authedRoute } from './authed.js';

export const customerGroupsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/customer-groups',
  validateSearch: listSearch,
  loaderDeps: ({ search }) => ({ after: search.after, limit: search.limit }),
  loader: ({ deps, abortController }) =>
    listCustomerGroups(deps.after, abortController.signal, deps.limit ?? PAGE_SIZE),
  component: CustomerGroupsPage,
});

/** A code from a name: "Key accounts (West)" gives "key_accounts_west". */
export function codeFromName(name: string): string {
  const code = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '');
  return code.slice(0, 63);
}

/** New customer group, in a sheet (CustomerGroups board). The code follows the name until edited. */
export function NewCustomerGroupSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const shownCode = codeEdited ? code : codeFromName(name);
  const codeError =
    problem?.code === 'customer_group_code_taken'
      ? 'This code is already used by another customer group.'
      : shownCode !== '' && !CODE_PATTERN.test(shownCode)
        ? 'Use 2 to 63 lowercase letters, digits or underscores, starting with a letter.'
        : errors['code'];

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await submit(() => createCustomerGroup({ code: shownCode, name }), {
      title: 'Customer group created',
      description: name,
    });
    if (created) {
      setName('');
      setCode('');
      setCodeEdited(false);
      onOpenChange(false);
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
          <SheetTitle>New customer group</SheetTitle>
          <SheetDescription>
            You can assign customers and price lists after saving.
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            {problem &&
            problem.code !== 'validation_failed' &&
            problem.code !== 'customer_group_code_taken' ? (
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
            <Field
              label="Code"
              hint={`${CODE_HINT} Used in imports and the API.`}
              error={codeError}
            >
              {(props) => (
                <Input
                  {...props}
                  required
                  className="font-mono"
                  maxLength={63}
                  value={shownCode}
                  onChange={(e) => {
                    setCodeEdited(true);
                    setCode(e.target.value);
                  }}
                />
              )}
            </Field>
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending}>
              Create customer group
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function CustomerGroupsPage() {
  const page = customerGroupsRoute.useLoaderData();
  const search = customerGroupsRoute.useSearch();
  const navigate = useNavigate();
  const manage = can(useSession(), 'customer.manage');
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
      New customer group
    </Button>
  ) : null;

  return (
    <Page>
      <Breadcrumbs
        crumbs={[{ label: 'Customers', to: '/customers' }, { label: 'Customer groups' }]}
      />
      <PageHeader
        title="Customer groups"
        description="Group customers to share price lists, settings and payment terms."
        actions={newButton}
      />
      {page.items.length === 0 && search.after === undefined ? (
        <EmptyState
          icon={Users}
          title="No customer groups yet"
          description="Customer groups let many customers share price lists and settings, for example Distributors."
          action={newButton ?? undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead aria-sort="ascending">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>
                  Price lists <PlannedTag />
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {page.items.map((group) => (
                <TableRow key={group.id}>
                  <TableCell className="font-mono text-[12.5px]">{group.code}</TableCell>
                  <TableCell className="font-[550]">{group.name}</TableCell>
                  <TableCell className="text-muted-foreground">Not built yet</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            after={search.after}
            nextAfter={page.nextAfter}
            limit={search.limit}
            shown={page.items.length}
            noun="customer groups"
          />
        </>
      )}
      {manage ? <NewCustomerGroupSheet open={search.new === true} onOpenChange={setNew} /> : null}
    </Page>
  );
}
