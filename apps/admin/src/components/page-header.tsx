import { Link } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';

export interface Crumb {
  label: string;
  /** Omit for the current page. */
  to?: string;
  params?: Record<string, string>;
}

/** Breadcrumbs from Home to the current page (Main board). */
export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  const all: Crumb[] =
    crumbs.length === 0 ? [{ label: 'Home' }] : [{ label: 'Home', to: '/' }, ...crumbs];
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
        {all.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${String(index)}`}>
            {index > 0 ? (
              <li aria-hidden="true" className="select-none">
                /
              </li>
            ) : null}
            <li>
              {crumb.to === undefined ? (
                <span aria-current="page" className="text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.to}
                  {...(crumb.params ? { params: crumb.params } : {})}
                  className="hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/** Page title, one line of description and the page's actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  leading,
  badges,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  badges?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      {leading}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">{title}</h1>
          {badges}
        </div>
        {description ? (
          <p className="m-0 mt-1 max-w-[70ch] text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** The page body: max 1400 px, 32 px side padding from 1280 px wide, 24 px below. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full max-w-[1400px] flex-col gap-5 px-6 pt-5 pb-12 xl:px-8">
      {children}
    </div>
  );
}
