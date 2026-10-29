import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { NewRoleDialog } from '../components/role-dialog.js';
import { Alert } from '../components/ui/alert.js';
import { Badge, PlannedTag, Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Tooltip } from '../components/ui/tooltip.js';
import {
  createAdminRole,
  deleteAdminRole,
  getAdminPermissions,
  listAdminRoles,
  setAdminRolePermissions,
  type AdminRole,
  type PermissionInfo,
} from '../lib/endpoints.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { authedRoute } from './authed.js';

/** Areas of the permission matrix in the board's order, by permission key prefix. */
const AREAS: [prefix: string, label: string][] = [
  ['admin_role', 'Admin roles'],
  ['admin_user', 'Admin users'],
  ['buyer_role', 'Buyer roles'],
  ['website', 'Websites'],
  ['setting', 'Settings'],
  ['customer', 'Customers'],
  ['product', 'Products'],
  ['price_list', 'Price lists'],
  ['order', 'Orders'],
];
const LEVELS = ['view', 'manage', 'assign'] as const;
const LEVEL_LABELS = { view: 'View', manage: 'Manage', assign: 'Assign' } as const;

export const NOT_HELD_TIP = 'You can only grant permissions you hold yourself.';

async function loadRoles({ abortController }: { abortController: AbortController }) {
  const [roles, permissions] = await Promise.all([
    listAdminRoles(abortController.signal),
    getAdminPermissions(abortController.signal),
  ]);
  return { roles, permissions };
}

export const adminRolesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin-roles',
  validateSearch: listSearch,
  loader: loadRoles,
  component: AdminRolesIndex,
});

export const adminRoleDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin-roles/$roleId',
  validateSearch: listSearch,
  loader: loadRoles,
  component: AdminRoleDetail,
});

function AdminRolesIndex() {
  const data = adminRolesRoute.useLoaderData();
  return (
    <AdminRolesPage {...data} roleId={undefined} open={adminRolesRoute.useSearch().new === true} />
  );
}

function AdminRoleDetail() {
  const data = adminRoleDetailRoute.useLoaderData();
  const { roleId } = adminRoleDetailRoute.useParams();
  return (
    <AdminRolesPage
      {...data}
      roleId={roleId}
      open={adminRoleDetailRoute.useSearch().new === true}
    />
  );
}

function areaRows(permissions: readonly PermissionInfo[]) {
  const byKey = new Map(permissions.map((p) => [p.key, p.description]));
  return AREAS.filter(([prefix]) => LEVELS.some((l) => byKey.has(`${prefix}.${l}`))).map(
    ([prefix, label]) => ({
      prefix,
      label,
      description: LEVELS.map((l) => byKey.get(`${prefix}.${l}`))
        .filter(Boolean)
        .join(' · '),
      cells: LEVELS.map((level) => {
        const key = `${prefix}.${level}`;
        return { level, key, exists: byKey.has(key) };
      }),
    }),
  );
}

function RoleMatrix({
  role,
  permissions,
}: {
  role: AdminRole;
  permissions: readonly PermissionInfo[];
}) {
  const session = useSession();
  const manage = can(session, 'admin_role.manage');
  const editable = manage && !role.isBuiltIn;
  const [granted, setGranted] = useState<Set<string>>(() => new Set(role.permissions));
  const save = useSubmit();
  const rows = areaRows(permissions);
  const dirty =
    granted.size !== role.permissions.length || role.permissions.some((p) => !granted.has(p));

  const toggle = (key: string, on: boolean) => {
    setGranted((g) => {
      const next = new Set(g);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return (
    <>
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!dirty}
            onClick={() => {
              setGranted(new Set(role.permissions));
              save.setProblem(undefined);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!dirty || save.pending}
            onClick={() =>
              void save.submit(
                () => setAdminRolePermissions(role.id, [...granted].sort()).then(() => true),
                {
                  title: 'Permissions saved',
                  description: role.name,
                },
              )
            }
          >
            Save permissions
          </Button>
        </div>
      ) : null}
      {save.problem ? <ProblemAlert problem={save.problem} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <span className="text-meta text-muted-foreground">
            {role.grantsAllPermissions
              ? 'Every permission'
              : `${String(granted.size)} of ${String(permissions.length)} granted`}
          </span>
          <span className="flex-1" />
          {editable ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" aria-hidden="true" />= you don’t hold this permission
            </span>
          ) : null}
        </CardHeader>
        <Table bare className="min-w-[640px]">
          <TableHeader>
            <tr>
              <TableHead className="w-40">Area</TableHead>
              <TableHead>What it allows</TableHead>
              {LEVELS.map((l) => (
                <TableHead key={l} className="w-20 text-center">
                  {LEVEL_LABELS[l]}
                </TableHead>
              ))}
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.prefix}>
                <th
                  scope="row"
                  className="h-[52px] border-b px-3 text-left text-control font-semibold"
                >
                  {row.label}
                </th>
                <TableCell className="text-meta whitespace-normal text-muted-foreground">
                  {row.description}
                </TableCell>
                {row.cells.map((cell) => {
                  if (!cell.exists) {
                    return (
                      <TableCell key={cell.level} className="text-center text-muted-foreground">
                        <span aria-label="Not applicable">–</span>
                      </TableCell>
                    );
                  }
                  const label = `${LEVEL_LABELS[cell.level]} ${row.label}`;
                  const checked = role.grantsAllPermissions || granted.has(cell.key);
                  const notHeld = editable && !session.permissions.has(cell.key);
                  const box = (
                    <span className="inline-flex items-center justify-center gap-1">
                      <Checkbox
                        aria-label={label}
                        checked={checked}
                        disabled={!editable || notHeld}
                        onCheckedChange={(value) => {
                          toggle(cell.key, value === true);
                        }}
                      />
                      {notHeld ? (
                        <Lock className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      ) : null}
                    </span>
                  );
                  return (
                    <TableCell key={cell.level} className="text-center">
                      {notHeld ? (
                        <Tooltip content={NOT_HELD_TIP}>
                          <span tabIndex={0} aria-label={`${label}: ${NOT_HELD_TIP}`}>
                            {box}
                          </span>
                        </Tooltip>
                      ) : (
                        box
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

function AdminRolesPage({
  roles,
  permissions,
  roleId,
  open,
}: {
  roles: AdminRole[];
  permissions: PermissionInfo[];
  roleId: string | undefined;
  open: boolean;
}) {
  const navigate = useNavigate();
  const session = useSession();
  const manage = can(session, 'admin_role.manage');
  const [duplicate, setDuplicate] = useState<AdminRole | undefined>();
  const [confirm, setConfirm] = useState(false);
  const role = roles.find((r) => r.id === roleId) ?? roles[0];
  const setNew = (next: boolean) => {
    if (!next) setDuplicate(undefined);
    void navigate({ to: '.', search: withNew<ListSearch>(next) });
  };

  return (
    <Page>
      <Breadcrumbs
        crumbs={[
          { label: 'Admin roles', to: '/admin-roles' },
          ...(role ? [{ label: role.name }] : []),
        ]}
      />
      <PageHeader
        title={role?.name ?? 'Admin roles'}
        badges={role ? <Tag className="font-mono">{role.code}</Tag> : null}
        description={
          role && role.description !== ''
            ? role.description
            : 'What admin users may do in the admin.'
        }
        actions={
          manage && role ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setDuplicate(role);
                  setNew(true);
                }}
              >
                Duplicate
              </Button>
              {role.isBuiltIn ? null : (
                <Button
                  variant="ghost-destructive"
                  onClick={() => {
                    setConfirm(true);
                  }}
                >
                  Delete role…
                </Button>
              )}
            </>
          ) : null
        }
      />
      <div className="flex flex-wrap items-start gap-5">
        <Card className="min-w-[260px] flex-[1_1_280px]">
          <CardHeader>
            <CardTitle>Admin roles</CardTitle>
            <span className="flex-1" />
            {manage ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDuplicate(undefined);
                  setNew(true);
                }}
              >
                <Plus aria-hidden="true" />
                New
              </Button>
            ) : null}
          </CardHeader>
          <ul className="m-0 list-none p-1.5">
            {roles.map((r) => (
              <li key={r.id}>
                <Link
                  to="/admin-roles/$roleId"
                  params={{ roleId: r.id }}
                  aria-current={r.id === role?.id ? 'page' : undefined}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-2 ${r.id === role?.id ? 'bg-accent' : 'hover:bg-muted'}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold">{r.name}</span>
                      {r.isBuiltIn ? (
                        <Badge variant="outline" className="h-[18px] text-[11px]">
                          <Lock className="size-[11px]" aria-hidden="true" />
                          Built-in
                        </Badge>
                      ) : null}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                  </span>
                  <span className="num text-xs text-muted-foreground">
                    {r.grantsAllPermissions ? 'All' : r.permissions.length}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <CardContent className="border-t">
            <Alert variant="muted" icon={<Lock />}>
              <span className="text-meta">
                <b>Administrator</b> is locked. It grants every permission and cannot be edited or
                deleted.
              </span>
            </Alert>
          </CardContent>
        </Card>
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
          {role ? (
            <RoleMatrix
              key={`${role.id}-${role.permissions.join(',')}`}
              role={role}
              permissions={permissions}
            />
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Admin users</CardTitle>
              <PlannedTag />
            </CardHeader>
            <CardContent className="text-meta text-muted-foreground">
              The admin users holding this role, with assigning and removing it, come with the admin
              users API. At least one admin user always keeps the administrator role.
            </CardContent>
          </Card>
        </div>
      </div>
      {manage ? (
        <NewRoleDialog
          key={duplicate?.id ?? 'new'}
          open={open}
          onOpenChange={setNew}
          noun="admin role"
          takenCode="role_code_taken"
          duplicateOf={duplicate?.name}
          create={(input) =>
            createAdminRole({
              ...input,
              // Only what the admin holds can be granted, so a duplicate starts with those.
              permissions: (duplicate?.permissions ?? []).filter((p) => session.permissions.has(p)),
            })
          }
          onCreated={(created) => {
            setDuplicate(undefined);
            void navigate({ to: '/admin-roles/$roleId', params: { roleId: created.id } });
          }}
        />
      ) : null}
      {manage && role && !role.isBuiltIn ? (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Delete admin role “${role.name}”?`}
          description="Admin users who hold it lose its permissions at once. This cannot be undone."
          confirmLabel="Delete admin role"
          onConfirm={async () => {
            await deleteAdminRole(role.id);
            await navigate({ to: '/admin-roles' });
          }}
        />
      ) : null}
    </Page>
  );
}
