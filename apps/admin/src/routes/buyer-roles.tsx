import { createRoute, Link, notFound } from '@tanstack/react-router';
import { PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { Badge } from '../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { allBuyerRoles, listBuyerRoles } from '../lib/endpoints.js';
import { listSearch as afterSearch } from '../lib/search.js';
import { authedRoute } from './authed.js';

/** Access levels in the glossary's words (Buyer role). */
const ACCESS_LEVEL_LABELS: Record<string, string> = {
  own_records: 'Own records',
  my_customer: 'My customer',
  my_customer_and_subsidiaries: 'My customer and subsidiaries',
};

export const buyerRolesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/buyer-roles',
  validateSearch: afterSearch,
  loaderDeps: ({ search }) => ({ after: search.after }),
  loader: ({ deps, abortController }) => listBuyerRoles(deps.after, abortController.signal),
  component: BuyerRolesPage,
});

function BuyerRolesPage() {
  const page = buyerRolesRoute.useLoaderData();
  const { after } = buyerRolesRoute.useSearch();
  return (
    <div>
      <PageHeader title="Buyer roles">
        Storefront permissions with an access level, by code.
      </PageHeader>
      {page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No buyer roles yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Permissions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((role) => (
              <TableRow key={role.id}>
                <TableCell>
                  <Link
                    to="/buyer-roles/$roleId"
                    params={{ roleId: role.id }}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {role.name}
                  </Link>{' '}
                  {role.isBuiltIn ? <Badge variant="outline">Built-in</Badge> : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{role.code}</TableCell>
                <TableCell>{role.grants.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager
        after={after}
        nextAfter={page.nextAfter}
        limit={undefined}
        shown={page.items.length}
        noun="rows"
      />
    </div>
  );
}

export const buyerRoleDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/buyer-roles/$roleId',
  loader: async ({ params, abortController }) => {
    const role = (await allBuyerRoles(abortController.signal)).find((r) => r.id === params.roleId);
    if (!role) throw notFound();
    return role;
  },
  component: BuyerRoleDetailPage,
  notFoundComponent: () => (
    <p className="text-sm text-muted-foreground">
      No such buyer role.{' '}
      <Link to="/buyer-roles" className="underline">
        Back to buyer roles
      </Link>
    </p>
  ),
});

function BuyerRoleDetailPage() {
  const role = buyerRoleDetailRoute.useLoaderData();
  return (
    <div>
      <PageHeader title={role.name}>
        <span className="font-mono text-xs">{role.code}</span>
        {role.isBuiltIn ? ' · Built-in' : ''}.
      </PageHeader>
      {role.description ? <p className="mb-6 text-sm">{role.description}</p> : null}
      <h2 className="mb-2 text-lg font-semibold">Grants</h2>
      {role.grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">This buyer role grants nothing.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Permission</TableHead>
              <TableHead>Access level</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {role.grants.map((grant) => (
              <TableRow key={grant.permission}>
                <TableCell className="font-mono text-xs">{grant.permission}</TableCell>
                <TableCell>{ACCESS_LEVEL_LABELS[grant.accessLevel] ?? grant.accessLevel}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
