import type { ReactNode } from 'react';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
    </header>
  );
}

export function ReadOnlyNote() {
  return <span>Read-only in this version.</span>;
}
