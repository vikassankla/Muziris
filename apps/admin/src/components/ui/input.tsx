import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

const base =
  'w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-control text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_25%,transparent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_15%,transparent)]';

export function Input({
  className,
  inputSize = 'default',
  ...props
}: ComponentProps<'input'> & { inputSize?: 'default' | 'sm' }) {
  return (
    <input
      className={cn(base, inputSize === 'sm' ? 'h-control-sm text-[13px]' : 'h-control', className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(base, 'min-h-20 py-2', className)} {...props} />;
}
