import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CircleAlert, Info, Lock } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

const alertVariants = cva('flex gap-2.5 rounded-lg border px-3.5 py-3 text-control', {
  variants: {
    variant: {
      default: 'bg-card text-foreground',
      muted: 'border-border bg-muted text-foreground',
      destructive:
        'border-[color-mix(in_srgb,var(--destructive)_40%,transparent)] bg-danger-soft text-destructive-text',
      warning:
        'border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-warning-soft text-warning',
      info: 'border-[color-mix(in_srgb,var(--info)_30%,transparent)] bg-info-soft text-info',
    },
  },
  defaultVariants: { variant: 'default' },
});

const ICONS = {
  default: Info,
  muted: Lock,
  destructive: CircleAlert,
  warning: AlertTriangle,
  info: Info,
} as const;

export type AlertProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & { icon?: ReactNode };

export function Alert({ className, variant, icon, children, role, ...props }: AlertProps) {
  const Icon = ICONS[variant ?? 'default'];
  return (
    <div
      role={role ?? (variant === 'destructive' || variant === 'warning' ? 'alert' : 'status')}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4" aria-hidden="true">
        {icon ?? <Icon />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('m-0 font-semibold', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[13px]', className)} {...props} />;
}
