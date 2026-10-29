import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex gap-0.5 overflow-x-auto border-b', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative inline-flex h-[38px] items-center gap-1.5 px-3 text-control whitespace-nowrap text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:hover:text-muted-foreground data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:after:absolute data-[state=active]:after:right-2 data-[state=active]:after:-bottom-px data-[state=active]:after:left-2 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-sm data-[state=active]:after:bg-primary data-[state=active]:after:content-['']",
        className,
      )}
      {...props}
    />
  );
}

/** A count in a tab, like "Buyer users 18". */
export function TabCount({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded-full bg-secondary px-1.5 text-[11px] font-[550] text-secondary-foreground">
      {children}
    </span>
  );
}
