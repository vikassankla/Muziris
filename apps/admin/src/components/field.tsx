import { CircleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Label } from './ui/label.js';

/**
 * A labelled form field with an optional hint and error (AddressForms, CustomerGroups boards).
 * The control is rendered by `children(props)` so it gets the id and aria attributes.
 */
export function Field({
  label,
  optional = false,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
  children: (props: {
    id: string;
    'aria-invalid': boolean | undefined;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </Label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <span id={errorId} className="flex items-center gap-1 text-meta text-destructive-text">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={hintId} className="text-meta text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
