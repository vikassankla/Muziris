import { Link, useRouter } from '@tanstack/react-router';
import { AlertTriangle, Lock, RotateCw, SearchX, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { SERVER_ERROR_TITLE, type ApiProblem } from '../lib/api.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/misc.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

// The shared states from the States board: loading, empty, no results, no access, error.

function StateIcon({
  icon: Icon,
  tone,
}: {
  icon: LucideIcon;
  tone: 'accent' | 'muted' | 'danger';
}) {
  const tones = {
    accent: 'bg-accent text-accent-foreground',
    muted: 'bg-muted text-muted-foreground',
    danger: 'bg-danger-soft text-destructive-text',
  } as const;
  return (
    <span
      className={`grid size-12 place-items-center rounded-xl ${tones[tone]}`}
      aria-hidden="true"
    >
      <Icon className="size-5" />
    </span>
  );
}

function StateCard({ children, role }: { children: ReactNode; role?: string }) {
  return (
    <div className="grid min-h-[320px] place-items-center rounded-lg border bg-background p-8 text-center">
      <div className="flex max-w-[360px] flex-col items-center gap-2.5" role={role}>
        {children}
      </div>
    </div>
  );
}

/** Empty list: what the screen holds, and the first thing to do. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <StateCard>
      <StateIcon icon={icon} tone="accent" />
      <h2 className="m-0 text-base font-[650]">{title}</h2>
      <p className="m-0 text-meta text-muted-foreground">{description}</p>
      {action ? <div className="mt-1.5 flex gap-2">{action}</div> : null}
    </StateCard>
  );
}

/** A filter or search that matches nothing. */
export function NoResults({
  title,
  description,
  onClear,
}: {
  title: string;
  description: string;
  onClear?: () => void;
}) {
  return (
    <div className="grid min-h-[240px] place-items-center rounded-lg border border-dashed p-8 text-center">
      <div className="flex max-w-[320px] flex-col items-center gap-2">
        <SearchX className="size-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="m-0 text-[15px] font-[650]">{title}</h2>
        <p className="m-0 text-meta text-muted-foreground">{description}</p>
        {onClear ? (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A 403 permission_denied from the API, whatever the navigation showed. */
export function NoAccess() {
  return (
    <StateCard>
      <StateIcon icon={Lock} tone="muted" />
      <h2 className="m-0 text-base font-[650]">You don’t have permission to view this.</h2>
      <p className="m-0 text-meta text-muted-foreground">Ask an administrator.</p>
      <Button variant="outline" asChild className="mt-1.5">
        <Link to="/">Go to Home</Link>
      </Button>
    </StateCard>
  );
}

/**
 * A screen that could not load. A 5xx always says the same thing; other problems show the API's
 * title. Either way the admin can try again, and the request id is there to quote.
 */
export function ErrorState({ problem, what }: { problem?: ApiProblem | undefined; what?: string }) {
  const router = useRouter();
  const server = problem === undefined || problem.status >= 500 || problem.status === 0;
  return (
    <StateCard role="alert">
      <StateIcon icon={AlertTriangle} tone="danger" />
      <h2 className="m-0 text-base font-[650]">
        {what ? `${what} could not be loaded` : 'This page could not be loaded'}
      </h2>
      <p className="m-0 text-meta text-muted-foreground">
        {server
          ? `${problem?.status === 0 ? problem.title : SERVER_ERROR_TITLE}. Your data is safe.`
          : problem.title}
      </p>
      {problem?.requestId ? (
        <p className="m-0 text-xs text-muted-foreground">Reference: {problem.requestId}</p>
      ) : null}
      <Button
        className="mt-1.5"
        onClick={() => {
          void router.invalidate();
        }}
      >
        <RotateCw aria-hidden="true" />
        Try again
      </Button>
    </StateCard>
  );
}

const SKELETON_WIDTHS = [
  ['70%', '50%'],
  ['55%', '62%'],
  ['80%', '40%'],
  ['62%', '55%'],
  ['48%', '66%'],
  ['74%', '45%'],
] as const;

/** Loading: a page title and skeleton rows, announced to screen readers. */
export function PendingPage() {
  return (
    <div
      className="flex w-full max-w-[1400px] flex-col gap-3.5 px-6 pt-5 pb-12 xl:px-8"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Loading
      </span>
      <Skeleton className="h-3 w-[120px]" />
      <Skeleton className="h-5 w-[180px]" />
      <Skeleton className="w-[280px]" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Skeleton className="w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="w-24" />
            </TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {SKELETON_WIDTHS.map(([a, b]) => (
            <TableRow key={a + b}>
              <TableCell>
                <Skeleton style={{ width: a }} />
              </TableCell>
              <TableCell>
                <Skeleton style={{ width: b }} />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto w-7" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
