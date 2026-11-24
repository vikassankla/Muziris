import { createRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Mail, MailX } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import {
  addSuppression,
  EMAIL_STATUSES,
  listEmails,
  listSuppressions,
  removeSuppression,
  retryEmail,
  type EmailStatus,
  type OutboxEmail,
  type Page as ListPage,
  type Suppression,
  type SuppressionReason,
} from '../lib/endpoints.js';
import { formatDateTime } from '../lib/format.js';
import { listSearch, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// The email outbox (ADR 0020): what went, what waits, and what gave up, newest first. And the
// suppressed addresses emails are not sent to (ADR 0032), on their own tab.

interface EmailsSearch extends ListSearch {
  state?: EmailStatus;
  tab?: 'suppressed';
  /** Search text on the suppressed addresses tab. */
  q?: string;
}

const ANY = '__any';

const STATUS_LABELS: Record<EmailStatus, string> = {
  queued: 'Waiting',
  sent: 'Sent',
  failed: 'Failed',
  bounced: 'Bounced',
  suppressed: 'Not sent: address suppressed',
};
const STATUS_TONES: Record<
  EmailStatus,
  'info' | 'success' | 'destructive' | 'warning' | 'neutral'
> = {
  queued: 'info',
  sent: 'success',
  failed: 'destructive',
  bounced: 'warning',
  suppressed: 'neutral',
};

/** Postmark's bounce types in words; any other is shown as Postmark names it. */
const BOUNCE_LABELS: Record<string, string> = {
  HardBounce: 'Hard bounce',
  SoftBounce: 'Soft bounce',
  Transient: 'Delayed',
  DnsError: 'DNS error',
  SpamComplaint: 'Spam complaint',
  SpamNotification: 'Blocked as spam',
  BadEmailAddress: 'Invalid address',
  ManuallyDeactivated: 'Deactivated in Postmark',
  Blocked: 'Blocked by the provider',
  AutoResponder: 'Automatic reply',
};
const bounceLabel = (type: string) => BOUNCE_LABELS[type] ?? type;

const REASON_LABELS: Record<SuppressionReason, string> = {
  hard_bounce: 'Hard bounce',
  spam_complaint: 'Spam complaint',
  smtp_rejected: 'Refused by the mail server',
  manual: 'Added by an admin',
};
const SOURCE_LABELS: Record<Suppression['source'], string> = {
  postmark: 'Postmark',
  smtp: 'Mail server',
  admin: 'Admin',
};

/** The catalogue's kinds in words (docs/notifications.md). */
const KIND_LABELS: Record<string, string> = {
  buyer_invitation: 'Invitation',
  admin_invitation: 'Admin invitation',
  order_placed: 'Order received (buyer)',
  order_received: 'New order (seller)',
  order_confirmed: 'Order confirmed',
  order_declined: 'Order declined',
  order_completed: 'Order delivered',
  payment_received: 'Payment received',
  payment_failed: 'Payment failed',
};

export const emailsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/emails',
  validateSearch: (search: Record<string, unknown>): EmailsSearch => {
    const state = search['state'];
    const q = search['q'];
    return {
      ...listSearch(search),
      ...(EMAIL_STATUSES.includes(state as EmailStatus) ? { state: state as EmailStatus } : {}),
      ...(search['tab'] === 'suppressed' ? { tab: 'suppressed' as const } : {}),
      ...(typeof q === 'string' && q.trim() !== '' && q.length <= 320 ? { q: q.trim() } : {}),
    };
  },
  loaderDeps: ({ search }) => ({
    tab: search.tab,
    after: search.after,
    limit: search.limit,
    status: search.state,
    q: search.q,
  }),
  loader: async ({
    deps,
    abortController,
  }): Promise<
    | { tab: 'emails'; page: ListPage<OutboxEmail> }
    | { tab: 'suppressed'; page: ListPage<Suppression> }
  > => {
    const paging = {
      after: deps.after,
      ...(deps.limit === undefined ? {} : { limit: deps.limit }),
    };
    return deps.tab === 'suppressed'
      ? {
          tab: 'suppressed',
          page: await listSuppressions({ ...paging, search: deps.q }, abortController.signal),
        }
      : {
          tab: 'emails',
          page: await listEmails({ ...paging, status: deps.status }, abortController.signal),
        };
  },
  component: EmailsPage,
});

function EmailsPage() {
  const data = emailsRoute.useLoaderData();
  const navigate = useNavigate();

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Emails' }]} />
      <PageHeader
        title="Emails"
        description="Emails to buyers and to your team, newest first. A failed email was tried five times over about three hours."
      />
      <Tabs
        value={data.tab}
        onValueChange={(value) => {
          void navigate({ to: '.', search: value === 'suppressed' ? { tab: 'suppressed' } : {} });
        }}
      >
        <TabsList aria-label="Email sections">
          <TabsTrigger value="emails">Emails</TabsTrigger>
          <TabsTrigger value="suppressed">Suppressed addresses</TabsTrigger>
        </TabsList>
        <TabsContent value="emails" className="flex flex-col gap-4">
          {data.tab === 'emails' ? <EmailList page={data.page} /> : null}
        </TabsContent>
        <TabsContent value="suppressed" className="flex flex-col gap-4">
          {data.tab === 'suppressed' ? <SuppressionList page={data.page} /> : null}
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function EmailList({ page }: { page: ListPage<OutboxEmail> }) {
  const search = emailsRoute.useSearch();
  const navigate = useNavigate();
  const website = useWebsite();
  const manage = can(useSession(), 'notification.manage');
  const { pending, problem, submit } = useSubmit();

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={search.state ?? ANY}
          onValueChange={(value) => {
            void navigate({
              to: '.',
              search: value === ANY ? {} : { state: value as EmailStatus },
            });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-[150px] rounded-full"
            aria-label="Status filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {EMAIL_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
      {page.items.length === 0 && search.after === undefined ? (
        <EmptyState
          icon={Mail}
          title={
            search.state
              ? `No ${STATUS_LABELS[search.state].toLowerCase()} emails`
              : 'No emails yet'
          }
          description="Emails appear here as invitations are sent and orders are placed."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead>Email</TableHead>
                <TableHead>To</TableHead>
                <TableHead aria-sort="descending">Queued</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {page.items.map((email) => (
                <TableRow key={email.id}>
                  <TableCell className="min-w-[240px] whitespace-normal">
                    <div className="font-[550]">{email.subject}</div>
                    <div className="text-xs text-muted-foreground">
                      {KIND_LABELS[email.kind] ?? email.kind}
                    </div>
                  </TableCell>
                  <TableCell>{email.recipient}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(email.createdAt, website)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_TONES[email.status]}>
                      {STATUS_LABELS[email.status]}
                    </Badge>
                    {email.bounceType ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {bounceLabel(email.bounceType)}
                      </div>
                    ) : null}
                    {email.lastError ? (
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
                        {email.lastError} · {email.attempts}{' '}
                        {email.attempts === 1 ? 'attempt' : 'attempts'}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {manage && email.status === 'failed' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void submit(() => retryEmail(email.id), {
                            title: 'Email queued again',
                            description: email.recipient,
                          })
                        }
                      >
                        Send again
                      </Button>
                    ) : null}
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
            noun="emails"
          />
        </>
      )}
    </>
  );
}

function SuppressionList({ page }: { page: ListPage<Suppression> }) {
  const search = emailsRoute.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const website = useWebsite();
  const manage = can(useSession(), 'notification.manage');
  const [query, setQuery] = useState(search.q ?? '');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Suppression | undefined>();

  return (
    <>
      <p className="max-w-prose text-sm text-muted-foreground">
        Emails are not sent to these addresses. An address is added when it bounces for good, when
        its owner marks an email as spam, when the mail server refuses it, or by an admin.
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const q = query.trim();
            void navigate({ to: '.', search: { tab: 'suppressed', ...(q ? { q } : {}) } });
          }}
        >
          <Field label="Search addresses" className="w-72">
            {(props) => (
              <Input
                {...props}
                type="search"
                maxLength={320}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {manage ? (
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            Add an address
          </Button>
        ) : null}
      </div>
      {page.items.length === 0 && search.after === undefined ? (
        <EmptyState
          icon={MailX}
          title={search.q ? 'No matching addresses' : 'No suppressed addresses'}
          description="Addresses appear here when emails to them bounce for good."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead>Address</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>From</TableHead>
                <TableHead aria-sort="descending">First seen</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {page.items.map((suppression) => {
                const reason = REASON_LABELS[suppression.reason];
                const bounce =
                  suppression.bounceType === null ? undefined : bounceLabel(suppression.bounceType);
                return (
                  <TableRow key={suppression.id}>
                    <TableCell>{suppression.email}</TableCell>
                    <TableCell>
                      <div>{reason}</div>
                      {bounce !== undefined && bounce !== reason ? (
                        <div className="text-xs text-muted-foreground">{bounce}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>{SOURCE_LABELS[suppression.source]}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(suppression.firstSeenAt, website)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(suppression.lastSeenAt, website)}
                    </TableCell>
                    <TableCell className="text-right">
                      {manage ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${suppression.email}`}
                          onClick={() => {
                            setRemoving(suppression);
                          }}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager
            after={search.after}
            nextAfter={page.nextAfter}
            limit={search.limit}
            shown={page.items.length}
            noun="addresses"
          />
        </>
      )}
      <AddSuppressionDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={`Remove ${removing?.email ?? ''}?`}
        description="Muziris will send emails to this address again. Postmark keeps its own block on it: reactivate it in Postmark too, or emails to it will bounce again."
        confirmLabel="Remove from the list"
        onConfirm={async () => {
          if (!removing) return;
          await removeSuppression(removing.id);
          toast.success('Address removed', { description: removing.email });
          await router.invalidate();
        }}
      />
    </>
  );
}

function AddSuppressionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const added = await submit(() => addSuppression(email), {
      title: 'Address added',
      description: email.trim(),
    });
    if (added) {
      setEmail('');
      onOpenChange(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a suppressed address</DialogTitle>
          <DialogDescription>
            No emails will be sent to it, for example when its owner asked not to be mailed.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem ? <ProblemAlert problem={problem} /> : null}
          <Field label="Email address">
            {(props) => (
              <Input
                {...props}
                type="email"
                required
                maxLength={320}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Add to the list
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
