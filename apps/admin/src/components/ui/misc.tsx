import { Avatar as AvatarPrimitive, Separator as SeparatorPrimitive } from 'radix-ui';
import type { ComponentProps, HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

export function Separator({ className, ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

/** Two initials from a name: "Priya Raman" gives "PR". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function Avatar({
  name,
  size = 'default',
  className,
}: {
  name: string;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full bg-accent font-[650] text-accent-foreground',
        size === 'sm' && 'size-6 text-[10px]',
        size === 'default' && 'size-7 text-[11.5px]',
        size === 'lg' && 'size-10 text-sm',
        className,
      )}
    >
      <AvatarPrimitive.Fallback aria-hidden="true">{initials(name)}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'h-3 rounded-sm bg-[linear-gradient(90deg,var(--muted),color-mix(in_srgb,var(--border)_80%,var(--muted)),var(--muted))]',
        className,
      )}
      {...props}
    />
  );
}

/** A keyboard key, as in "Ctrl K". */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 items-center rounded-[4px] border border-b-2 bg-muted px-1.5 font-sans text-[11px] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
