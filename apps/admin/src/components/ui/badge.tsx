import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

// Status badges from the Tokens board: the text always carries the meaning; the dot repeats it.
const badgeVariants = cva(
  'inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full border border-transparent px-2 text-xs font-[550] whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
        info: 'bg-info-soft text-info',
        destructive: 'bg-danger-soft text-destructive-text',
        neutral: 'bg-muted text-muted-foreground',
        outline: 'border-border bg-transparent text-foreground',
      },
      dot: { true: '', false: '' },
    },
    compoundVariants: [
      {
        dot: true,
        className:
          "before:size-1.5 before:rounded-full before:bg-current before:opacity-90 before:content-['']",
      },
    ],
    defaultVariants: { variant: 'default', dot: true },
  },
);

export function Badge({
  className,
  variant,
  dot,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  const hollow = variant === 'neutral' && dot !== false;
  return (
    <span
      className={cn(
        badgeVariants({ variant, dot: variant === 'outline' ? (dot ?? false) : dot }),
        hollow && 'before:border-[1.5px] before:border-current before:bg-transparent',
        className,
      )}
      {...props}
    />
  );
}

/** A small grey label: product type, code, "Admin". */
export function Tag({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-sm bg-muted px-1.5 text-[11.5px] font-[550] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

/** Marks a tab or column the design has but the product does not have yet. */
export function PlannedTag({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'rounded-sm border border-dashed border-input px-1 text-[10.5px] font-semibold tracking-[0.03em] text-muted-foreground uppercase',
        className,
      )}
      {...props}
    >
      Planned
    </span>
  );
}
