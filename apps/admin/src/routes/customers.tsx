import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Building2, Filter, MoreHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';
import { ChangeCustomerDialog, NewCustomerSheet } from '../components/customer-dialogs.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { EmptyState, NoResults } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
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
import { allCustomerGroups, listCustomers, type Customer } from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

interface CustomersSearch extends ListSearch {
  groupId?: string;
}

const ALL_GROUPS = '__all';

export const customersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/customers',
  validateSearch: (search: Record<string, unknown>): CustomersSearch => {
    const groupId = search['groupId'];
    return {
      ...listSearch(search),
      ...(typeof groupId === 'string' && groupId ? { groupId } : {}),
    };
  },
  loaderDeps: ({ search }) => ({
    after: search.after,
    limit: search.limit,
    groupId: search.groupId,
  }),
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal;
    const [page, groups, names] = await Promise.all([
      listCustomers(
        {
          after: deps.after,
          ...(deps.limit === undefined ? {} : { limit: deps.limit }),
          ...(deps.groupId === undefined ? {} : { groupId: deps.groupId }),
        },
        signal,
      ),
      allCustomerGroups(signal),
      // For parent names and the parent pickers: the first 200 customers by name.
      listCustomers({ limit: 200 }, signal),
    ]);
    return { page, groups, known: names.items };
  },
  component: CustomersPage,
});

type Change = { customer: Customer; kind: 'group' | 'parent' } | undefined;

function CustomersPage() {
  const { page, groups, known } = customersRoute.useLoaderData();
  const search = customersRoute.useSearch();
  const navigate = useNavigate();
  const session = useSession();
  const website = useWebsite();
  const manage = can(session, 'customer.manage');
  const [change, setChange] = useState<Change>();
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const customerName = new Map([...known, ...page.items].map((c) => [c.id, c.name]));
  const filtered = search.groupId !== undefined;

  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew<CustomersSearch>(open) });
  };

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Customers' }]} />
      <PageHeader
        title="Customers"
        description="Companies that buy from you, with their subsidiaries and buyer users."
        actions={
          manage ? (
            <Button
              onClick={() => {
                setNew(true);
              }}
            >
              <Plus aria-hidden="true" />
              New customer
            </Button>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={search.groupId ?? ALL_GROUPS}
          onValueChange={(value) => {
            void navigate({ to: '.', search: value === ALL_GROUPS ? {} : { groupId: value } });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-[220px] rounded-full"
            aria-label="Customer group filter"
          >
            <span className="flex items-center gap-1.5">
              <Filter className="size-3.5" aria-hidden="true" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_GROUPS}>Every customer group</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered ? (
          <Button variant="ghost" size="sm" asChild>
            <Link to="." search={{}}>
              Clear filters
            </Link>
          </Button>
        ) : null}
      </div>

      {page.items.length === 0 ? (
        filtered ? (
          <NoResults
            title="No customers in this customer group"
            description="Pick another customer group, or clear the filter."
            onClear={() => void navigate({ to: '.', search: {} })}
          />
        ) : (
          <EmptyState
            icon={Building2}
            title="No customers yet"
            description="Add the companies that buy from you. You can invite their buyer users once a customer exists."
            action={
              manage ? (
                <Button
                  onClick={() => {
                    setNew(true);
                  }}
                >
                  <Plus aria-hidden="true" />
                  New customer
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead aria-sort="ascending">Name</TableHead>
                <TableHead>Customer group</TableHead>
                <TableHead>Parent customer</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {page.items.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    <Link
                      to="/customers/$customerId"
                      params={{ customerId: customer.id }}
                      className="font-[550] text-foreground hover:underline"
                    >
                      {customer.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {customer.groupId === null ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      (groupName.get(customer.groupId) ?? 'Unknown customer group')
                    )}
                  </TableCell>
                  <TableCell>
                    {customer.parentId === null ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: customer.parentId }}
                        className="text-primary underline decoration-primary/40 underline-offset-2"
                      >
                        {customerName.get(customer.parentId) ?? 'View parent customer'}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="num text-muted-foreground">
                    {formatDate(customer.createdAt, website)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${customer.name}`}
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[230px]">
                        <DropdownMenuItem asChild>
                          <Link to="/customers/$customerId" params={{ customerId: customer.id }}>
                            Open
                          </Link>
                        </DropdownMenuItem>
                        {manage ? (
                          <>
                            <DropdownMenuItem asChild>
                              <Link
                                to="/customers/$customerId"
                                params={{ customerId: customer.id }}
                                search={{ tab: 'invitations', new: true }}
                              >
                                Invite a buyer user
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => {
                                setChange({ customer, kind: 'group' });
                              }}
                            >
                              Change customer group
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                setChange({ customer, kind: 'parent' });
                              }}
                            >
                              Set parent customer
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            after={search.after}
            nextAfter={page.nextAfter}
            limit={search.limit}
            shown={page.items.length}
            noun="customers"
          />
        </>
      )}

      {manage ? (
        <NewCustomerSheet
          open={search.new === true}
          onOpenChange={setNew}
          groups={groups}
          customers={known}
          onCreated={(customer) => {
            void navigate({ to: '/customers/$customerId', params: { customerId: customer.id } });
          }}
        />
      ) : null}
      {change ? (
        <ChangeCustomerDialog
          key={`${change.customer.id}-${change.kind}`}
          customer={change.customer}
          kind={change.kind}
          open
          onOpenChange={(open) => {
            if (!open) setChange(undefined);
          }}
          groups={groups}
          customers={known}
        />
      ) : null}
    </Page>
  );
}
