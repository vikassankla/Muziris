import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-[13px] leading-none font-[550]', className)} {...props} />;
}
