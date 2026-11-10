import { createRoute, Link } from '@tanstack/react-router';
import { Copy } from 'lucide-react';
import { useId } from 'react';
import { toast } from 'sonner';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
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
import {
  getPaymentGateways,
  type PaymentGatewayStatus,
  type SettingPaymentMethod,
  type WebsitePayments,
} from '../lib/endpoints.js';
import { formatDateTime } from '../lib/format.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// The payments screen (ADR 0030), read only. Gateway keys stay in the server's env file (ADR
// 0019): the screen says which are set, shows the key the browser already gets, and explains how
// to change them. It never shows or takes a secret.

const METHOD_LABELS: Record<SettingPaymentMethod, string> = {
  terms: 'On payment terms',
  stripe_card: 'Card (Stripe)',
  stripe_ach: 'US bank account (Stripe)',
  razorpay: 'Razorpay',
};

const OUTCOME_LABELS: Record<NonNullable<PaymentGatewayStatus['lastEvent']>['outcome'], string> = {
  applied: 'Applied',
  ignored: 'Nothing to change',
  amount_mismatch: 'Amount did not match',
  unknown_payment: 'Payment not found',
};

export const paymentsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/payments',
  loader: ({ abortController }) => getPaymentGateways(abortController.signal),
  component: PaymentsPage,
});

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}`, {
      description: 'Select it and copy it instead.',
    });
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

function GatewayCard({ gateway }: { gateway: PaymentGatewayStatus }) {
  const website = useWebsite();
  const titleId = useId();
  const event = gateway.lastEvent;
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId}>{gateway.name}</CardTitle>
        <Badge variant={gateway.configured ? 'success' : 'neutral'}>
          {gateway.configured ? 'Configured' : 'Not configured'}
        </Badge>
        {gateway.mode ? (
          <Badge variant={gateway.mode === 'live' ? 'info' : 'warning'}>
            {gateway.mode === 'live' ? 'Live mode' : 'Test mode'}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        <dl className="m-0 grid gap-4 sm:grid-cols-2">
          <Fact label="Payment methods">
            {gateway.methods.map((m) => METHOD_LABELS[m]).join(', ')} ·{' '}
            {gateway.currencies.join(', ')} only
          </Fact>
          <Fact label="Public key">
            {gateway.publicKey ? (
              <code className="font-mono text-sm break-all">{gateway.publicKey}</code>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </Fact>
          <Fact label="Webhook address">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 font-mono text-sm break-all select-all">
                {gateway.webhookUrl}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Copy the ${gateway.name} webhook address`}
                onClick={() => {
                  void copy(gateway.webhookUrl, 'Webhook address');
                }}
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
          </Fact>
          <Fact label="Last webhook">
            {event ? (
              <>
                <div>
                  {formatDateTime(event.receivedAt, website)} ·{' '}
                  <span className="font-mono text-xs">{event.type}</span>
                </div>
                <div className="text-muted-foreground">{OUTCOME_LABELS[event.outcome]}</div>
              </>
            ) : (
              <span className="text-muted-foreground">No webhook received yet</span>
            )}
            {gateway.refusedEvents7Days > 0 ? (
              <div className="mt-1 text-destructive-text">
                {gateway.refusedEvents7Days} refused in the last 7 days
              </div>
            ) : null}
          </Fact>
          <Fact label="Server variables">
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {gateway.variables.map((v) => (
                <li key={v.name} className="flex items-center gap-2">
                  <code className="font-mono text-xs">{v.name}</code>
                  <Badge variant={v.set ? 'success' : 'neutral'}>{v.set ? 'Set' : 'Not set'}</Badge>
                </li>
              ))}
            </ul>
          </Fact>
        </dl>
      </CardContent>
    </Card>
  );
}

function WebsitesTable({ websites }: { websites: WebsitePayments[] }) {
  const session = useSession();
  const canChange = can(session, 'setting.view');
  return (
    <Table>
      <TableHeader>
        <tr>
          <TableHead>Website</TableHead>
          <TableHead>Checkout offers</TableHead>
          <TableHead>Warnings</TableHead>
          {canChange ? <TableHead className="sr-only">Change</TableHead> : null}
        </tr>
      </TableHeader>
      <TableBody>
        {websites.map((w) => (
          <TableRow key={w.id}>
            <TableCell>
              <div className="font-[550]">{w.name}</div>
              <div className="text-xs text-muted-foreground">{w.currency}</div>
            </TableCell>
            <TableCell>
              {w.offered.length === 0 ? (
                <span className="text-destructive-text">Nothing: every order is refused</span>
              ) : (
                <ul className="m-0 list-none p-0">
                  {w.offered.map((m) => (
                    <li key={m}>{METHOD_LABELS[m]}</li>
                  ))}
                </ul>
              )}
            </TableCell>
            <TableCell>
              {w.warnings.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-warning">
                  {w.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </TableCell>
            {canChange ? (
              <TableCell className="text-right">
                <Link
                  to="/settings"
                  search={{ website: w.id }}
                  aria-label={`Change for ${w.name}`}
                  className="text-primary underline underline-offset-2"
                >
                  Change
                </Link>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PaymentsPage() {
  const { gateways, websites } = paymentsRoute.useLoaderData();
  const names = gateways.flatMap((g) => g.variables.map((v) => v.name));

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Payments' }]} />
      <PageHeader
        title="Payments"
        description="The payment gateways set up on the server, where they send webhooks, and the payment methods each website offers at checkout."
      />
      {gateways.map((gateway) => (
        <GatewayCard key={gateway.gateway} gateway={gateway} />
      ))}
      <Card>
        <CardHeader>
          <CardTitle>How to change the keys</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="m-0">
            Gateway keys are kept in the server&apos;s env file, never in the database or this
            screen. To add or change them:
          </p>
          <ol className="m-0 flex flex-col gap-1 pl-5">
            <li>
              Edit the env file on the server (
              <code className="font-mono">/etc/muziris/muziris.env</code>) and set{' '}
              {names.map((n, i) => (
                <span key={n}>
                  {i > 0 ? ', ' : ''}
                  <code className="font-mono text-xs">{n}</code>
                </span>
              ))}
              . Set every variable of a gateway, or none.
            </li>
            <li>
              Restart with <code className="font-mono">deploy/muziris up -d</code>.
            </li>
            <li>Paste the webhook address above into the gateway&apos;s dashboard.</li>
          </ol>
          <Alert variant="info">
            <AlertDescription>
              Live keys are refused unless <code className="font-mono">PAYMENTS_LIVE=true</code> is
              also set.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Websites</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <WebsitesTable websites={websites} />
        </CardContent>
      </Card>
    </Page>
  );
}
