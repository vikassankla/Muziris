import { createRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { getCustomer, listCustomers, listSubsidiaries, type Customer } from '../lib/endpoints.js';
import { afterSearch } from '../lib/redirect.js';
import { authedRoute } from './authed.js';

/** How far up the hierarchy the detail view walks; deeper trees show the nearest levels. */
const MAX_ANCESTORS = 20;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export const customersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/customers',
  validateSearch: afterSearch,
  loaderDeps: ({ search }) => ({ after: search.after }),
  loader: ({ deps, abortController }) =>
    listCustomers({ after: deps.after }, abortController.signal),
  component: CustomersPage,
});

function CustomerTable({ customers }: { customers: Customer[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Place in hierarchy</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {customers.map((customer) => (
          <TableRow key={customer.id}>
            <TableCell>
              <Link
                to="/customers/$customerId"
                params={{ customerId: customer.id }}
                search={{}}
                className="font-medium underline-offset-4 hover:underline"
              >
                {customer.name}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {customer.parentId === null ? 'Top-level customer' : 'Subsidiary'}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDate(customer.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CustomersPage() {
  const page = customersRoute.useLoaderData();
  const { after } = customersRoute.useSearch();
  return (
    <div>
      <PageHeader title="Customers">Every customer by name.</PageHeader>
      {page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No customers yet.</p>
      ) : (
        <CustomerTable customers={page.items} />
      )}
      <Pager after={after} nextAfter={page.nextAfter} />
    </div>
  );
}

export const customerDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/customers/$customerId',
  validateSearch: afterSearch,
  loaderDeps: ({ search }) => ({ after: search.after }),
  loader: async ({ params, deps, abortController }) => {
    const signal = abortController.signal;
    const [customer, subsidiaries] = await Promise.all([
      getCustomer(params.customerId, signal),
      listSubsidiaries(params.customerId, deps.after, signal),
    ]);
    // Walk up to the top-level customer, nearest parent last in the list.
    const ancestors: Customer[] = [];
    let parentId = customer.parentId;
    while (parentId !== null && ancestors.length < MAX_ANCESTORS) {
      const parent = await getCustomer(parentId, signal);
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    return { customer, ancestors, truncated: parentId !== null, subsidiaries };
  },
  component: CustomerDetailPage,
});

function CustomerDetailPage() {
  const { customer, ancestors, truncated, subsidiaries } = customerDetailRoute.useLoaderData();
  const { after } = customerDetailRoute.useSearch();
  return (
    <div>
      <PageHeader title={customer.name}>Created {formatDate(customer.createdAt)}.</PageHeader>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Hierarchy</h2>
        <nav aria-label="Hierarchy">
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {truncated ? <li className="text-muted-foreground">…&nbsp;›</li> : null}
            {ancestors.map((ancestor) => (
              <li key={ancestor.id} className="flex items-center gap-1">
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: ancestor.id }}
                  search={{}}
                  className="underline-offset-4 hover:underline"
                >
                  {ancestor.name}
                </Link>
                <span aria-hidden="true">›</span>
              </li>
            ))}
            <li aria-current="page" className="font-medium">
              {customer.name}
            </li>
          </ol>
        </nav>
        {ancestors.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">This is a top-level customer.</p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Subsidiaries</h2>
        {subsidiaries.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subsidiaries.</p>
        ) : (
          <CustomerTable customers={subsidiaries.items} />
        )}
        <Pager after={after} nextAfter={subsidiaries.nextAfter} />
      </section>
    </div>
  );
}
