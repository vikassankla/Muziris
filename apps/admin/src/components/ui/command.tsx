import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

// shadcn/ui Command, built on cmdk: the command palette and searchable pickers.
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex flex-col overflow-hidden bg-popover text-popover-foreground', className)}
      {...props}
    />
  );
}

export function CommandInput({
  className,
  large = false,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input> & { large?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5 border-b px-3.5', large ? 'h-[52px]' : 'h-10')}>
      <Search
        className={cn('shrink-0 text-muted-foreground', large ? 'size-5' : 'size-4')}
        aria-hidden="true"
      />
      <CommandPrimitive.Input
        className={cn(
          'h-full flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none',
          large ? 'text-[15px]' : 'text-control',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[460px] overflow-y-auto p-1.5', className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="py-6 text-center text-meta text-muted-foreground"
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'flex h-10 cursor-default items-center gap-2 rounded-sm px-2 text-control outline-none select-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}
