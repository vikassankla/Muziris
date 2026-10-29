import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Building2, Mail, MapPin, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { AddressSheet } from '../components/address-sheet.js';
import {
  AddBuyerUserDialog,
  AssignBuyerRoleDialog,
  InviteDialog,
  LinkBuyerUserDialog,
} from '../components/buyer-user-dialogs.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { ChangeCustomerDialog, NewCustomerSheet } from '../components/customer-dialogs.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { EmptyState } from '../components/states.js';
import { Badge, PlannedTag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { TabCount, Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { GST_STATE_CODES, US_STATES } from '../lib/address-rules.js';
import {
  allBuyerRoles,
  allCustomerGroups,
  getCustomer,
  listAddresses,
  listBuyerUsers,
  listCustomers,
  listInvitations,
  listSubsidiaries,
  revokeInvitation,
  type Address,
  type BuyerRole,
  type Customer,
  type Invitation,
} from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

const TABS = ['overview', 'buyer-users', 'invitations', 'addresses'] as const;
type Tab = (typeof TABS)[number];

/** Tabs the CustomerDetail board shows that wait for other modules. */
const PLANNED_TABS = ['Orders', 'Quotes', 'Price lists', 'Settings overrides', 'Payment term'];

interface DetailSearch {
  tab?: Tab;
  new?: boolean;
}

/** At most this many customers are drawn in the hierarchy tree, top-level customer first. */
const TREE_LIMIT = 50;

interface TreeNode {
  customer: Customer;
  level: number;
}

/** The whole hierarchy from the top-level customer down, breadth first, one call per parent. */
async function loadTree(
  root: Customer,
  signal: AbortSignal,
): Promise<{ nodes: TreeNode[]; truncated: boolean }> {
  const children = new Map<string, Customer[]>();
  const queue: Customer[] = [root];
  let count = 1;
  let truncated = false;
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    const page = await listSubsidiaries(parent.id, undefined, signal);
    if (page.nextAfter !== null) truncated = true;
    const kids = page.items.slice(0, Math.max(0, TREE_LIMIT - count));
    if (kids.length < page.items.length) truncated = true;
    count += kids.length;
    children.set(parent.id, kids);
    queue.push(...kids);
    if (count >= TREE_LIMIT) {
      truncated = truncated || queue.length > 0;
      break;
    }
  }
  const nodes: TreeNode[] = [];
  const walk = (customer: Customer, level: number) => {
    nodes.push({ customer, level });
    for (const child of children.get(customer.id) ?? []) walk(child, level + 1);
  };
  walk(root, 1);
  return { nodes, truncated };
}

export const customerDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/customers/$customerId',
  validateSearch: (search: Record<string, unknown>): DetailSearch => {
    const tab = search['tab'];
    return {
      ...(typeof tab === 'string' && (TABS as readonly string[]).includes(tab)
        ? { tab: tab as Tab }
        : {}),
      ...(search['new'] === true || search['new'] === 'true' ? { new: true } : {}),
    };
  },
  loader: async ({ params, abortController, context }) => {
    const signal = abortController.signal;
    const customer = await getCustomer(params.customerId, signal);
    const ancestors: Customer[] = [];
    let parentId = customer.parentId;
    while (parentId !== null && ancestors.length < 20) {
      const parent = await getCustomer(parentId, signal);
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    const root = ancestors[0] ?? customer;
    const canRoles = context.session.permissions.has('buyer_role.view');
    const [tree, groups, buyerUsers, invitations, addresses, known, buyerRoles] = await Promise.all(
      [
        loadTree(root, signal),
        allCustomerGroups(signal),
        listBuyerUsers(customer.id, undefined, signal),
        listInvitations(customer.id, undefined, signal),
        listAddresses(customer.id, undefined, signal),
        listCustomers({ limit: 200 }, signal),
        canRoles ? allBuyerRoles(signal) : Promise.resolve([] as BuyerRole[]),
      ],
    );
    return {
      customer,
      ancestors,
      tree,
      groups,
      buyerUsers,
      invitations,
      addresses,
      known: known.items,
      buyerRoles,
    };
  },
  component: CustomerDetailPage,
});

type Dialogs =
  | { kind: 'group' | 'parent' | 'subsidiary' | 'add-buyer' | 'link-buyer' | 'address' }
  | { kind: 'assign-role'; userId: string }
  | { kind: 'revoke'; invitation: Invitation }
  | undefined;

function regionName(address: Address): string {
  if (address.countryCode === 'IN') {
    return `${GST_STATE_CODES[address.regionCode] ?? address.regionCode} (${address.regionCode})`;
  }
  return US_STATES[address.regionCode] ?? address.regionCode;
}

function CustomerDetailPage() {
  const data = customerDetailRoute.useLoaderData();
  const {
    customer,
    ancestors,
    tree,
    groups,
    buyerUsers,
    invitations,
    addresses,
    known,
    buyerRoles,
  } = data;
  const search = customerDetailRoute.useSearch();
  const navigate = useNavigate();
  const session = useSession();
  const website = useWebsite();
  const manage = can(session, 'customer.manage');
  const assignRoles = can(session, 'buyer_role.manage');
  const [dialog, setDialog] = useState<Dialogs>();
  const revoke = useSubmit();
  const tab: Tab = search.tab ?? 'overview';
  const group = groups.find((g) => g.id === customer.groupId);
  const subsidiaries = tree.nodes.filter((n) => n.customer.parentId === customer.id).length;
  const close = () => {
    setDialog(undefined);
  };
  const defaultBilling = addresses.items.find((a) => a.isDefaultBilling)?.label;
  const defaultShipping = addresses.items.find((a) => a.isDefaultShipping)?.label;

  const setTab = (next: string) => {
    void navigate({
      to: '.',
      search: next === 'overview' ? {} : { tab: next as Tab },
      replace: true,
    });
  };
  const inviteOpen = search.tab === 'invitations' && search.new === true;

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Customers', to: '/customers' }, { label: customer.name }]} />
      <PageHeader
        leading={
          <span
            className="grid size-10 place-items-center rounded-[10px] bg-accent text-accent-foreground"
            aria-hidden="true"
          >
            <Building2 className="size-5" />
          </span>
        }
        title={customer.name}
        badges={
          <>
            {group ? <Badge variant="info">{group.name}</Badge> : null}
            <Badge variant="outline">
              {customer.parentId === null ? 'Top-level customer' : 'Subsidiary'}
            </Badge>
          </>
        }
        description={`${String(subsidiaries)} ${subsidiaries === 1 ? 'subsidiary' : 'subsidiaries'} · ${String(buyerUsers.items.length)}${buyerUsers.nextAfter ? '+' : ''} buyer users · customer since ${formatDate(customer.createdAt, website)}`}
        actions={
          manage ? (
            <Button
              onClick={() => {
                void navigate({ to: '.', search: { tab: 'invitations', new: true } });
              }}
            >
              <Mail aria-hidden="true" />
              Invite a buyer user
            </Button>
          ) : null
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Customer sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="buyer-users">
            Buyer users{' '}
            <TabCount>
              {buyerUsers.items.length}
              {buyerUsers.nextAfter ? '+' : ''}
            </TabCount>
          </TabsTrigger>
          <TabsTrigger value="invitations">
            Invitations <TabCount>{invitations.items.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="addresses">
            Addresses <TabCount>{addresses.items.length}</TabCount>
          </TabsTrigger>
          {PLANNED_TABS.map((label) => (
            <TabsTrigger key={label} value={`planned-${label}`} disabled>
              {label} <PlannedTag />
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-5 flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="m-0">{customer.name}</dd>
                <dt className="text-muted-foreground">Customer group</dt>
                <dd className="m-0 flex items-center">
                  <span className="flex-1">
                    {group ? group.name : <span className="text-muted-foreground">None</span>}
                  </span>
                  {manage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDialog({ kind: 'group' });
                      }}
                    >
                      Change
                    </Button>
                  ) : null}
                </dd>
                <dt className="text-muted-foreground">Parent customer</dt>
                <dd className="m-0 flex items-center">
                  <span className="flex-1">
                    {ancestors.at(-1) ? (
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: ancestors.at(-1)?.id ?? '' }}
                        className="text-primary underline decoration-primary/40 underline-offset-2"
                      >
                        {ancestors.at(-1)?.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">None (top-level customer)</span>
                    )}
                  </span>
                  {manage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDialog({ kind: 'parent' });
                      }}
                    >
                      Change
                    </Button>
                  ) : null}
                </dd>
                <dt className="text-muted-foreground">Customer since</dt>
                <dd className="num m-0">{formatDate(customer.createdAt, website)}</dd>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Hierarchy</CardTitle>
              <span className="flex-1" />
              {manage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDialog({ kind: 'subsidiary' });
                  }}
                >
                  <Plus aria-hidden="true" />
                  Add subsidiary
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              <ul role="tree" aria-label="Customer hierarchy" className="m-0 list-none p-0">
                {tree.nodes.map(({ customer: node, level }) => {
                  const current = node.id === customer.id;
                  return (
                    <li
                      key={node.id}
                      role="treeitem"
                      aria-level={level}
                      aria-selected={current}
                      aria-current={current ? 'true' : undefined}
                      className={`flex h-10 items-center gap-2 rounded-md ${current ? 'bg-accent' : ''}`}
                      style={{ paddingLeft: `${String(8 + (level - 1) * 28)}px` }}
                    >
                      <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
                      {current ? (
                        <span className="font-semibold">{node.name}</span>
                      ) : (
                        <Link
                          to="/customers/$customerId"
                          params={{ customerId: node.id }}
                          className="text-primary underline decoration-primary/40 underline-offset-2"
                        >
                          {node.name}
                        </Link>
                      )}
                      {current ? <Badge variant="outline">This customer</Badge> : null}
                    </li>
                  );
                })}
              </ul>
              {tree.truncated ? (
                <p className="m-0 mt-2 text-meta text-muted-foreground">
                  Showing the first {TREE_LIMIT} customers in this hierarchy.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="buyer-users" className="mt-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta text-muted-foreground">
              Names and emails come with a later change to identity; buyer users show by user id.
            </span>
            <span className="flex-1" />
            {manage ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDialog({ kind: 'link-buyer' });
                  }}
                >
                  Link existing buyer user
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setDialog({ kind: 'add-buyer' });
                  }}
                >
                  <Plus aria-hidden="true" />
                  Add buyer user
                </Button>
              </>
            ) : null}
          </div>
          {buyerUsers.items.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No buyer users yet"
              description="Invite the people who order for this customer, or add them directly."
            />
          ) : (
            <Table>
              <TableHeader>
                <tr>
                  <TableHead>Buyer user</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-48">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {buyerUsers.items.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell className="font-mono text-xs">{user.userId}</TableCell>
                    <TableCell className="num text-muted-foreground">
                      {formatDate(user.createdAt, website)}
                    </TableCell>
                    <TableCell className="text-right">
                      {assignRoles ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDialog({ kind: 'assign-role', userId: user.userId });
                          }}
                        >
                          Assign buyer role
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="invitations" className="mt-5 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-meta text-muted-foreground">
              Invitations that can still be accepted, oldest first.
            </span>
            <span className="flex-1" />
            {manage ? (
              <Button
                size="sm"
                onClick={() => {
                  void navigate({ to: '.', search: { tab: 'invitations', new: true } });
                }}
              >
                <Mail aria-hidden="true" />
                Invite a buyer user
              </Button>
            ) : null}
          </div>
          {invitations.items.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No open invitations"
              description="Invitations you send appear here until they are accepted, revoked or expire."
            />
          ) : (
            <Table>
              <TableHeader>
                <tr>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {invitations.items.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>{invitation.displayName}</TableCell>
                    <TableCell className="num">
                      {formatDate(invitation.createdAt, website)}
                    </TableCell>
                    <TableCell className="num">
                      {formatDate(invitation.expiresAt, website)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="info">Pending</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {manage ? (
                        <Button
                          variant="ghost-destructive"
                          size="sm"
                          onClick={() => {
                            setDialog({ kind: 'revoke', invitation });
                          }}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="addresses" className="mt-5 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-meta text-muted-foreground">
              {addresses.items.length} {addresses.items.length === 1 ? 'address' : 'addresses'}
            </span>
            <span className="flex-1" />
            {manage ? (
              <Button
                size="sm"
                onClick={() => {
                  setDialog({ kind: 'address' });
                }}
              >
                <Plus aria-hidden="true" />
                Add address
              </Button>
            ) : null}
          </div>
          {addresses.items.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="No addresses yet"
              description="Add the billing and shipping addresses buyers choose from at checkout."
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {addresses.items.map((address) => (
                <article
                  key={address.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <h3 className="m-0 text-sm font-[620]">{address.label}</h3>
                  {address.isDefaultBilling || address.isDefaultShipping ? (
                    <div className="flex flex-wrap gap-1.5">
                      {address.isDefaultBilling ? (
                        <Badge variant="success">Default billing</Badge>
                      ) : null}
                      {address.isDefaultShipping ? (
                        <Badge variant="success">Default shipping</Badge>
                      ) : null}
                    </div>
                  ) : null}
                  <address className="text-meta whitespace-pre-line not-italic">
                    {[
                      address.line1,
                      address.line2,
                      `${address.city}, ${regionName(address)}`,
                      `${address.postalCode}, ${address.countryCode === 'IN' ? 'India' : 'United States'}`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  </address>
                  {address.countryCode === 'IN' ? (
                    <div className="font-mono text-xs text-muted-foreground">
                      {address.gstin ? `GSTIN ${address.gstin}` : 'No GSTIN'}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {manage ? (
        <>
          <ChangeCustomerDialog
            key={`group-${customer.id}-${customer.groupId ?? ''}`}
            customer={customer}
            kind="group"
            open={dialog?.kind === 'group'}
            onOpenChange={close}
            groups={groups}
            customers={known}
          />
          <ChangeCustomerDialog
            key={`parent-${customer.id}-${customer.parentId ?? ''}`}
            customer={customer}
            kind="parent"
            open={dialog?.kind === 'parent'}
            onOpenChange={close}
            groups={groups}
            customers={known}
          />
          <NewCustomerSheet
            open={dialog?.kind === 'subsidiary'}
            onOpenChange={(open) => {
              if (!open) close();
            }}
            groups={groups}
            customers={known}
            parentId={customer.id}
            onCreated={close}
          />
          <AddBuyerUserDialog
            open={dialog?.kind === 'add-buyer'}
            onOpenChange={close}
            customerId={customer.id}
            customerName={customer.name}
          />
          <LinkBuyerUserDialog
            open={dialog?.kind === 'link-buyer'}
            onOpenChange={close}
            customerId={customer.id}
            customerName={customer.name}
          />
          <InviteDialog
            open={inviteOpen}
            onOpenChange={(open) => {
              void navigate({
                to: '.',
                search: { tab: 'invitations', ...(open ? { new: true } : {}) },
                replace: true,
              });
            }}
            customerId={customer.id}
            customerName={customer.name}
          />
          <AddressSheet
            open={dialog?.kind === 'address'}
            onOpenChange={(open) => {
              if (!open) close();
            }}
            customerId={customer.id}
            customerName={customer.name}
            defaultCountry={website.locale === 'en-US' ? 'US' : 'IN'}
            currentDefaults={{ billing: defaultBilling, shipping: defaultShipping }}
          />
          <ConfirmDialog
            open={dialog?.kind === 'revoke'}
            onOpenChange={(open) => {
              if (!open) close();
            }}
            title={
              dialog?.kind === 'revoke'
                ? `Revoke the invitation to ${dialog.invitation.email}?`
                : 'Revoke invitation?'
            }
            description="The person can no longer use it to join this customer. You can send a new one later."
            confirmLabel="Revoke invitation"
            onConfirm={async () => {
              if (dialog?.kind !== 'revoke') return;
              const { invitation } = dialog;
              await revokeInvitation(invitation.id);
              await revoke.submit(() => Promise.resolve(true), {
                title: 'Invitation revoked',
                description: invitation.email,
              });
            }}
          />
        </>
      ) : null}
      {assignRoles && dialog?.kind === 'assign-role' ? (
        <AssignBuyerRoleDialog
          open
          onOpenChange={close}
          userId={dialog.userId}
          roles={buyerRoles}
        />
      ) : null}
    </Page>
  );
}
