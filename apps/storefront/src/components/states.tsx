import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { PackageOpen, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { isApiProblem, SERVER_ERROR_TITLE } from '../lib/api.js';
import { Alert, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';

// The States board (docs/design/storefront/States.dc.html).

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2.5 px-7 py-10 text-center">
      {icon ? (
        <span className="text-muted-foreground [&_svg]:size-7" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2 className="m-0 text-base font-[620]">{title}</h2>
      {children ? (
        <p className="m-0 max-w-[44ch] text-meta text-muted-foreground">{children}</p>
      ) : null}
      {action}
    </Card>
  );
}

export function EmptyCategory({ name, action }: { name: string; action?: ReactNode }) {
  return (
    <EmptyState icon={<PackageOpen />} title="No products here yet" action={action}>
      There are no products in {name} that you can order. Try another category, or search by SKU.
    </EmptyState>
  );
}

/** One page for a product that does not exist and one the buyer may not see (ADR 0014). */
export function ProductNotFound({ action }: { action?: ReactNode }) {
  return (
    <EmptyState icon={<SearchX />} title="We can’t find that product" action={action}>
      It may have been removed, or it isn’t in your company’s catalogue. Search for it by name or
      SKU.
    </EmptyState>
  );
}

/** "Something went wrong": a fixed message and the request id as the reference, nothing else. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const problem = isApiProblem(error) ? error : undefined;
  const network = problem?.code === 'network_error';
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{network ? problem.title : SERVER_ERROR_TITLE}</AlertTitle>
      {network ? null : <span>It’s a problem on our side, not with your account.</span>}
      {problem?.requestId ? <span className="text-xs">Reference: {problem.requestId}</span> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-1.5 self-start" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Alert>
  );
}

/** A route's error component: the error state, with a retry that reloads the route. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-[1280px] p-6">
      <ErrorState
        error={error}
        onRetry={() => {
          void router.invalidate();
        }}
      />
    </div>
  );
}

const SKELETON_WIDTHS = ['220px', '180px', '240px', '160px', '200px'];

/** Rows of grey bars while a list loads. */
export function PendingList() {
  return (
    <div className="mx-auto w-full max-w-[1280px] p-6" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
        {SKELETON_WIDTHS.map((width) => (
          <div key={width} className="flex items-center gap-6">
            <div className="h-3 w-24 rounded-sm bg-muted" />
            <div className="h-3 rounded-sm bg-muted" style={{ width }} />
            <div className="ml-auto h-3 w-16 rounded-sm bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
