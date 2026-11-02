import { createRoute, useNavigate } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
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
import { EMAIL_STATUSES, listEmails, retryEmail, type EmailStatus } from '../lib/endpoints.js';
import { formatDateTime } from '../lib/format.js';
import { listSearch, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// The email outbox (ADR 0020): what went, what waits, and what gave up, newest first.

interface EmailsSearch extends ListSearch {
  state?: EmailStatus;
}

const ANY = '__any';

const STATUS_LABELS: Record<EmailStatus, string> = {
  queued: 'Waiting',
  sent: 'Sent',
  failed: 'Failed',
};
const STATUS_TONES: Record<EmailStatus, 'info' | 'success' | 'destructive'> = {
  queued: 'info',
  sent: 'success',
  failed: 'destructive',
};

/** The catalogue's kinds in words (docs/notifications.md). */
const KIND_LABELS: Record<string, string> = {
  buyer_invitation: 'Invitation',
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
    return {
      ...listSearch(search),
      ...(EMAIL_STATUSES.includes(state as EmailStatus) ? { state: state as EmailStatus } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ after: search.after, limit: search.limit, status: search.state }),
  loader: ({ deps, abortController }) =>
    listEmails(
      {
        after: deps.after,
        status: deps.status,
        ...(deps.limit === undefined ? {} : { limit: deps.limit }),
      },
      abortController.signal,
    ),
  component: EmailsPage,
});

function EmailsPage() {
  const page = emailsRoute.useLoaderData();
  const search = emailsRoute.useSearch();
  const navigate = useNavigate();
  const website = useWebsite();
  const manage = can(useSession(), 'notification.manage');
  const { pending, problem, submit } = useSubmit();

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Emails' }]} />
      <PageHeader
        title="Emails"
        description="Emails to buyers and to your team, newest first. A failed email was tried five times over about three hours."
      />
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
    </Page>
  );
}
