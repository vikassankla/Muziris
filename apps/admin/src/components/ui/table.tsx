import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

/** A table in its bordered card; rows are 44 px, or 38 px when compact. */
export function Table({
  className,
  compact = false,
  bare = false,
  ...props
}: HTMLAttributes<HTMLTableElement> & { compact?: boolean; bare?: boolean }) {
  const table = (
    <table
      data-compact={compact || undefined}
      className={cn('group/table w-full border-collapse text-control', className)}
      {...props}
    />
  );
  if (bare) return <div className="overflow-x-auto">{table}</div>;
  return <div className="overflow-x-auto rounded-lg border bg-card">{table}</div>;
}

export function TableHeader(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child>td]:border-b-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        '[tbody>&]:hover:bg-[color-mix(in_srgb,var(--muted)_70%,transparent)] data-[selected=true]:bg-[color-mix(in_srgb,var(--accent)_70%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'h-row-compact border-b bg-muted px-3 text-left text-meta font-[550] whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn(
        'h-row border-b px-3 whitespace-nowrap group-data-[compact]/table:h-row-compact',
        className,
      )}
      {...props}
    />
  );
}
