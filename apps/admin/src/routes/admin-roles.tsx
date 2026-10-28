import { createRoute } from '@tanstack/react-router';
import { PageHeader, ReadOnlyNote } from '../components/page-header.js';
import { Badge } from '../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { listAdminRoles } from '../lib/endpoints.js';
import { authedRoute } from './authed.js';

export const adminRolesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin-roles',
  loader: ({ abortController }) => listAdminRoles(abortController.signal),
  component: AdminRolesPage,
});

function AdminRolesPage() {
  const roles = adminRolesRoute.useLoaderData();
  return (
    <div>
      <PageHeader title="Admin roles">
        Roles that admin users hold, with their permissions. <ReadOnlyNote />
      </PageHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Code</TableHead>
            <TableHead>Permissions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roles.map((role) => (
            <TableRow key={role.id}>
              <TableCell className="align-top">
                <div className="font-medium">{role.name}</div>
                {role.description ? (
                  <div className="text-xs text-muted-foreground">{role.description}</div>
                ) : null}
                {role.isBuiltIn ? (
                  <Badge variant="secondary" className="mt-1">
                    Built-in
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="align-top font-mono text-xs">{role.code}</TableCell>
              <TableCell className="align-top">
                {role.grantsAllPermissions ? (
                  <span>Every permission, including ones added later</span>
                ) : role.permissions.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {role.permissions.map((permission) => (
                      <li key={permission}>
                        <Badge variant="outline" className="font-mono">
                          {permission}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
