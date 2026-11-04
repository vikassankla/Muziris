import { createRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { MoreHorizontal, Plus, UserCog } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Badge, Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
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
import { Tooltip } from '../components/ui/tooltip.js';
import {
  assignAdminRole,
  disableAdminUser,
  enableAdminUser,
  inviteAdminUser,
  listAdminRoles,
  listAdminUsers,
  resendAdminInvitation,
  resetAdminTwoFactor,
  unassignAdminRole,
  type AdminRole,
  type AdminUserRow,
  type AdminUserStatus,
} from '../lib/endpoints.js';
import { formatDateTime } from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can, type Session } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { NOT_HELD_TIP } from './admin-roles.js';
import { authedRoute } from './authed.js';

// Admin users (ADR 0028): who works in the admin, with their roles, two-factor sign-in and
// status; inviting an admin by email, and disabling, enabling and resetting two-factor.

export const adminUsersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin-users',
  validateSearch: listSearch,
  loaderDeps: ({ search }) => ({ after: search.after, limit: search.limit }),
  loader: async ({ deps, abortController, context }) => {
    const signal = abortController.signal;
    const [users, roles] = await Promise.all([
      listAdminUsers(deps, signal),
      context.session.permissions.has('admin_role.view')
        ? listAdminRoles(signal)
        : Promise.resolve([] as AdminRole[]),
    ]);
    return { users, roles };
  },
  component: AdminUsersPage,
});

export const STATUS_LABELS: Record<AdminUserStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
};
const STATUS_TONES: Record<AdminUserStatus, 'success' | 'info' | 'neutral'> = {
  active: 'success',
  invited: 'info',
  disabled: 'neutral',
};

/** Whether this admin may give the role: they must hold every permission it grants. */
function mayGive(session: Session, role: AdminRole): boolean {
  return (
    can(session, 'admin_role.assign') && role.permissions.every((p) => session.permissions.has(p))
  );
}

function RoleChoice({
  role,
  checked,
  allowed,
  disabled,
  onChange,
}: {
  role: AdminRole;
  checked: boolean;
  allowed: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = `role-${role.id}`;
  const box = (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={!allowed || disabled === true}
        onCheckedChange={(next) => {
          onChange(next === true);
        }}
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{role.name}</Label>
        {role.description ? (
          <span className="text-meta text-muted-foreground">{role.description}</span>
        ) : null}
      </div>
    </div>
  );
  return allowed ? box : <Tooltip content={NOT_HELD_TIP}>{box}</Tooltip>;
}

function InviteSheet({
  open,
  onOpenChange,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly AdminRole[];
}) {
  const session = useSession();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  function reset() {
    setDisplayName('');
    setEmail('');
    setRoleIds([]);
    setProblem(undefined);
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const invited = await submit(() => inviteAdminUser({ displayName, email, roleIds }), {
      title: 'Invitation sent',
      description: email,
    });
    if (invited) {
      reset();
      onOpenChange(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Invite an admin user</SheetTitle>
          <SheetDescription>
            They get an email with a link to set a password, good for 72 hours. Then they sign in
            and set up two-factor sign-in.
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <SheetBody>
            {problem && problem.code !== 'validation_failed' && problem.code !== 'email_taken' ? (
              <ProblemAlert problem={problem} />
            ) : null}
            <Field label="Name" error={errors['displayName']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={200}
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Email"
              error={
                problem?.code === 'email_taken' ? 'An admin user has this email.' : errors['email']
              }
            >
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                />
              )}
            </Field>
            {roles.length > 0 && can(session, 'admin_role.assign') ? (
              <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
                <legend className="mb-2 text-sm font-semibold">Admin roles</legend>
                {roles.map((role) => (
                  <RoleChoice
                    key={role.id}
                    role={role}
                    allowed={mayGive(session, role)}
                    checked={roleIds.includes(role.id)}
                    onChange={(checked) => {
                      setRoleIds((ids) =>
                        checked ? [...ids, role.id] : ids.filter((i) => i !== role.id),
                      );
                    }}
                  />
                ))}
              </fieldset>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending}>
              Send invitation
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Gives and takes away one admin's roles, each at once, with the API's refusals. */
function RolesDialog({
  user,
  roles,
  onClose,
}: {
  user: AdminUserRow;
  roles: readonly AdminRole[];
  onClose: () => void;
}) {
  const session = useSession();
  const { pending, problem, submit } = useSubmit();
  const held = new Set(user.roles.map((r) => r.id));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Admin roles for {user.displayName}</DialogTitle>
          <DialogDescription>
            A change applies at once. At least one active admin user keeps the administrator role.
          </DialogDescription>
        </DialogHeader>
        {problem ? <ProblemAlert problem={problem} /> : null}
        <div className="flex flex-col gap-3">
          {roles.map((role) => (
            <RoleChoice
              key={role.id}
              role={role}
              allowed={mayGive(session, role)}
              disabled={pending}
              checked={held.has(role.id)}
              onChange={(checked) => {
                void submit(
                  () =>
                    checked
                      ? assignAdminRole(user.id, role.id)
                      : unassignAdminRole(user.id, role.id),
                  { title: checked ? `${role.name} given` : `${role.name} taken away` },
                );
              }}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Open =
  | { kind: 'roles'; user: AdminUserRow }
  | { kind: 'reset'; user: AdminUserRow }
  | { kind: 'disable'; user: AdminUserRow };

function AdminUsersPage() {
  const { users, roles } = adminUsersRoute.useLoaderData();
  const search = adminUsersRoute.useSearch();
  const navigate = useNavigate({ from: '/admin-users' });
  const session = useSession();
  const website = useWebsite();
  const manage = can(session, 'admin_user.manage');
  const assign = can(session, 'admin_role.assign') && roles.length > 0;
  const [open, setOpen] = useState<Open | undefined>();
  const router = useRouter();
  const { problem, submit } = useSubmit();
  const close = () => {
    setOpen(undefined);
  };
  const setNew = (next: boolean) => {
    void navigate({ to: '.', search: withNew<ListSearch>(next) });
  };

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Admin users' }]} />
      <PageHeader
        title="Admin users"
        description="Who works in the admin, with their roles. Every admin signs in with a password and an authenticator app."
        actions={
          manage ? (
            <Button
              onClick={() => {
                setNew(true);
              }}
            >
              <Plus aria-hidden="true" />
              Invite an admin user
            </Button>
          ) : undefined
        }
      />
      {problem ? <ProblemAlert problem={problem} /> : null}
      {users.items.length === 0 ? (
        <EmptyState
          icon={UserCog}
          title="No admin users on this page"
          description="Go back to the first page."
        />
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Admin roles</TableHead>
              <TableHead>Two-factor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sign-in</TableHead>
              {manage || assign ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </tr>
          </TableHeader>
          <TableBody>
            {users.items.map((user) => {
              const own = user.id === session.user.id;
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-semibold">
                    {user.displayName} {own ? <Tag>You</Tag> : null}
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    {user.roles.length === 0 ? (
                      <span className="text-muted-foreground">No roles</span>
                    ) : (
                      user.roles.map((r) => r.name).join(', ')
                    )}
                  </TableCell>
                  <TableCell>
                    {user.twoFactor ? (
                      'On'
                    ) : (
                      <span className="text-muted-foreground">Not set up</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_TONES[user.status]}>{STATUS_LABELS[user.status]}</Badge>
                  </TableCell>
                  <TableCell>
                    {user.lastSignInAt ? (
                      formatDateTime(user.lastSignInAt, website)
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  {manage || assign ? (
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${user.displayName}`}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[230px]">
                          {assign ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                setOpen({ kind: 'roles', user });
                              }}
                            >
                              Change admin roles
                            </DropdownMenuItem>
                          ) : null}
                          {manage && user.status === 'invited' ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                void submit(() => resendAdminInvitation(user.id), {
                                  title: 'Invitation sent again',
                                  description: user.email,
                                });
                              }}
                            >
                              Send invitation again
                            </DropdownMenuItem>
                          ) : null}
                          {manage && !own && user.twoFactor ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                setOpen({ kind: 'reset', user });
                              }}
                            >
                              Reset two-factor
                            </DropdownMenuItem>
                          ) : null}
                          {manage && !own && user.status !== 'disabled' ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                setOpen({ kind: 'disable', user });
                              }}
                            >
                              Disable
                            </DropdownMenuItem>
                          ) : null}
                          {manage && user.status === 'disabled' ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                void submit(() => enableAdminUser(user.id), {
                                  title: 'Admin user enabled',
                                  description: user.displayName,
                                });
                              }}
                            >
                              Enable
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <Pager
        after={search.after}
        nextAfter={users.nextAfter}
        limit={search.limit}
        shown={users.items.length}
        noun="admin users"
      />
      {manage ? (
        <InviteSheet open={search.new === true} onOpenChange={setNew} roles={roles} />
      ) : null}
      {open?.kind === 'roles' ? (
        <RolesDialog
          // The dialog reads the row again after each change.
          user={users.items.find((u) => u.id === open.user.id) ?? open.user}
          roles={roles}
          onClose={close}
        />
      ) : null}
      <ConfirmDialog
        open={open?.kind === 'reset'}
        onOpenChange={(o) => {
          if (!o) close();
        }}
        title={`Reset two-factor for ${open?.user.displayName ?? ''}?`}
        description="They are signed out everywhere now, and set up an authenticator app again at their next sign-in."
        confirmLabel="Reset two-factor"
        onConfirm={async () => {
          if (open?.kind !== 'reset') return;
          await resetAdminTwoFactor(open.user.id);
          toast.success('Two-factor reset', { description: open.user.displayName });
          await router.invalidate();
        }}
      />
      <ConfirmDialog
        open={open?.kind === 'disable'}
        onOpenChange={(o) => {
          if (!o) close();
        }}
        title={`Disable ${open?.user.displayName ?? ''}?`}
        description="They are signed out everywhere now and cannot sign in until enabled again. Their history stays."
        confirmLabel="Disable"
        onConfirm={async () => {
          if (open?.kind !== 'disable') return;
          await disableAdminUser(open.user.id);
          toast.success('Admin user disabled', { description: open.user.displayName });
          await router.invalidate();
        }}
      />
    </Page>
  );
}
