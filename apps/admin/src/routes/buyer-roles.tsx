import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { NewRoleDialog } from '../components/role-dialog.js';
import { EmptyState } from '../components/states.js';
import { Badge, Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import {
  allBuyerRoles,
  createBuyerRole,
  deleteBuyerRole,
  getBuyerPermissions,
  setBuyerRoleGrants,
  type BuyerRole,
  type BuyerRoleGrant,
  type PermissionInfo,
} from '../lib/endpoints.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { authedRoute } from './authed.js';

const NONE = 'none';

/** Access levels in the glossary's words (Buyer role), with what each means for a buyer. */
export const LEVELS: { value: string; label: string; explain: string }[] = [
  { value: NONE, label: 'None', explain: 'The buyer cannot see or use this at all.' },
  {
    value: 'own_records',
    label: 'Own records',
    explain: 'Only records the buyer created themself.',
  },
  {
    value: 'my_customer',
    label: 'My customer',
    explain: 'Records of everyone at the buyer’s own customer.',
  },
  {
    value: 'my_customer_and_subsidiaries',
    label: 'My customer and subsidiaries',
    explain: 'Also every subsidiary below it, at any depth.',
  },
];

async function loadRoles({ abortController }: { abortController: AbortController }) {
  const [roles, catalogue] = await Promise.all([
    allBuyerRoles(abortController.signal),
    getBuyerPermissions(abortController.signal),
  ]);
  return { roles, permissions: catalogue.permissions };
}

export const buyerRolesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/buyer-roles',
  validateSearch: listSearch,
  loader: loadRoles,
  component: BuyerRolesIndex,
});

export const buyerRoleDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/buyer-roles/$roleId',
  validateSearch: listSearch,
  loader: loadRoles,
  component: BuyerRoleDetail,
});

function BuyerRolesIndex() {
  const data = buyerRolesRoute.useLoaderData();
  return (
    <BuyerRolesPage {...data} roleId={undefined} open={buyerRolesRoute.useSearch().new === true} />
  );
}

function BuyerRoleDetail() {
  const data = buyerRoleDetailRoute.useLoaderData();
  const { roleId } = buyerRoleDetailRoute.useParams();
  return (
    <BuyerRolesPage
      {...data}
      roleId={roleId}
      open={buyerRoleDetailRoute.useSearch().new === true}
    />
  );
}

function levelsOf(role: BuyerRole): Record<string, string> {
  return Object.fromEntries(role.grants.map((g) => [g.permission, g.accessLevel]));
}

function AccessMatrix({
  role,
  permissions,
}: {
  role: BuyerRole;
  permissions: readonly PermissionInfo[];
}) {
  const manage = can(useSession(), 'buyer_role.manage');
  const editable = manage && !role.isBuiltIn;
  const [levels, setLevels] = useState<Record<string, string>>(() => levelsOf(role));
  const save = useSubmit();
  const original = levelsOf(role);
  const dirty = permissions.some((p) => (levels[p.key] ?? NONE) !== (original[p.key] ?? NONE));
  const grants: BuyerRoleGrant[] = Object.entries(levels)
    .filter(([, level]) => level !== NONE)
    .map(([permission, accessLevel]) => ({ permission, accessLevel }))
    .sort((a, b) => a.permission.localeCompare(b.permission));

  return (
    <>
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!dirty}
            onClick={() => {
              setLevels(levelsOf(role));
              save.setProblem(undefined);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!dirty || save.pending}
            onClick={() =>
              void save.submit(() => setBuyerRoleGrants(role.id, grants).then(() => true), {
                title: 'Buyer role saved',
                description: role.name,
              })
            }
          >
            Save buyer role
          </Button>
        </div>
      ) : null}
      {save.problem ? <ProblemAlert problem={save.problem} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Access levels</CardTitle>
          <span className="text-meta text-muted-foreground">
            One level per storefront permission
          </span>
        </CardHeader>
        <Table bare className="min-w-[720px]">
          <TableHeader>
            <tr>
              <TableHead>Storefront permission</TableHead>
              {LEVELS.map((l) => (
                <TableHead
                  key={l.value}
                  className="w-[140px] py-2 text-center leading-tight whitespace-normal"
                >
                  {l.label}
                </TableHead>
              ))}
            </tr>
          </TableHeader>
          <TableBody>
            {permissions.map((permission) => {
              const value = levels[permission.key] ?? NONE;
              const labelId = `bp-${permission.key}`;
              return (
                <RadioGroup
                  key={permission.key}
                  asChild
                  className="table-row"
                  value={value}
                  disabled={!editable}
                  aria-labelledby={labelId}
                  onValueChange={(next) => {
                    setLevels((l) => ({ ...l, [permission.key]: next }));
                  }}
                >
                  <TableRow>
                    <th scope="row" className="h-14 border-b px-3 text-left">
                      <span className="flex flex-col gap-px">
                        <span className="font-semibold" id={labelId}>
                          {permission.description}
                        </span>
                        <span className="font-mono text-xs font-normal text-muted-foreground">
                          {permission.key}
                        </span>
                      </span>
                    </th>
                    {LEVELS.map((level) => (
                      <TableCell
                        key={level.value}
                        className={`text-center ${value === level.value ? 'bg-[color-mix(in_srgb,var(--accent)_60%,transparent)]' : ''}`}
                      >
                        <RadioGroupItem
                          value={level.value}
                          aria-label={`${permission.description}: ${level.label}`}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                </RadioGroup>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What each level means for a buyer</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {LEVELS.map((level) => (
            <div key={level.value} className="flex flex-col gap-1.5 rounded-lg border p-3">
              <span className="font-semibold">{level.label}</span>
              <span className="text-meta">{level.explain}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

function BuyerRolesPage({
  roles,
  permissions,
  roleId,
  open,
}: {
  roles: BuyerRole[];
  permissions: PermissionInfo[];
  roleId: string | undefined;
  open: boolean;
}) {
  const navigate = useNavigate();
  const manage = can(useSession(), 'buyer_role.manage');
  const [duplicate, setDuplicate] = useState<BuyerRole | undefined>();
  const [confirm, setConfirm] = useState(false);
  const role = roles.find((r) => r.id === roleId) ?? roles[0];
  const setNew = (next: boolean) => {
    if (!next) setDuplicate(undefined);
    void navigate({ to: '.', search: withNew<ListSearch>(next) });
  };
  const newButton = manage ? (
    <Button
      onClick={() => {
        setDuplicate(undefined);
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New buyer role
    </Button>
  ) : null;

  return (
    <Page>
      <Breadcrumbs
        crumbs={[
          { label: 'Buyer roles', to: '/buyer-roles' },
          ...(role ? [{ label: role.name }] : []),
        ]}
      />
      <PageHeader
        title={role?.name ?? 'Buyer roles'}
        badges={
          role ? (
            <>
              <Tag className="font-mono">{role.code}</Tag>
              {role.isBuiltIn ? <Badge variant="outline">Built-in</Badge> : null}
            </>
          ) : null
        }
        description={
          role && role.description !== ''
            ? role.description
            : 'What a buyer user with this role can do on the storefront.'
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
                  Delete buyer role…
                </Button>
              )}
            </>
          ) : null
        }
      />
      {roles.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No buyer roles yet"
          description="Buyer roles decide what buyer users can do on the storefront, for example Purchaser or Approver."
          action={newButton ?? undefined}
        />
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <Card className="min-w-[240px] flex-[1_1_260px]">
            <CardHeader>
              <CardTitle>Buyer roles</CardTitle>
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
                    to="/buyer-roles/$roleId"
                    params={{ roleId: r.id }}
                    aria-current={r.id === role?.id ? 'page' : undefined}
                    className={`flex items-center gap-2 rounded-md px-2.5 py-2 ${r.id === role?.id ? 'bg-accent' : 'hover:bg-muted'}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-semibold">{r.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.grants.length} {r.grants.length === 1 ? 'permission' : 'permissions'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
            {role ? (
              <AccessMatrix
                key={`${role.id}-${role.grants.map((g) => g.permission + g.accessLevel).join(',')}`}
                role={role}
                permissions={permissions}
              />
            ) : null}
          </div>
        </div>
      )}
      {manage ? (
        <NewRoleDialog
          key={duplicate?.id ?? 'new'}
          open={open}
          onOpenChange={setNew}
          noun="buyer role"
          takenCode="role_code_taken"
          duplicateOf={duplicate?.name}
          create={(input) => createBuyerRole({ ...input, grants: duplicate?.grants ?? [] })}
          onCreated={(created) => {
            setDuplicate(undefined);
            void navigate({ to: '/buyer-roles/$roleId', params: { roleId: created.id } });
          }}
        />
      ) : null}
      {manage && role && !role.isBuiltIn ? (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Delete buyer role “${role.name}”?`}
          description="Buyer users who hold it lose its storefront permissions at once. This cannot be undone."
          confirmLabel="Delete buyer role"
          onConfirm={async () => {
            await deleteBuyerRole(role.id);
            await navigate({ to: '/buyer-roles' });
          }}
        />
      ) : null}
    </Page>
  );
}
