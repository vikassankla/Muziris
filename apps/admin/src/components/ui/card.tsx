import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps) {
  return (
    <div className={cn('rounded-lg border bg-card text-card-foreground', className)} {...props} />
  );
}

/** Card header row: title, then anything else (badges, actions) pushed right with a spacer. */
export function CardHeader({ className, ...props }: DivProps) {
  return (
    <div className={cn('flex items-center gap-2 border-b px-4 py-3.5', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('m-0 text-card-title font-[620]', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-meta text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: DivProps) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: DivProps) {
  return <div className={cn('flex justify-end gap-2 border-t px-4 py-3', className)} {...props} />;
}
