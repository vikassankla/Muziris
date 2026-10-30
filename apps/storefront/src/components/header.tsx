import { Link, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import type { CategoryTree } from '../lib/categories.js';
import type { ShellData } from '../lib/session.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';

export function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-[26px] place-items-center rounded-[7px] bg-primary text-[13px] font-bold text-primary-foreground"
    >
      M
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

export function SearchForm({ initial = '' }: { initial?: string }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState(initial);

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (q === '') return;
    void navigate({ to: '/search', search: { q } });
  }

  return (
    <form
      role="search"
      className="relative flex max-w-[560px] flex-[1_1_320px] items-center"
      onSubmit={handleSubmit}
    >
      <Search
        className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
        aria-hidden="true"
      />
      <label className="sr-only" htmlFor="site-search">
        Search products by name or SKU
      </label>
      <Input
        id="site-search"
        type="search"
        className="h-11 pl-8 text-body md:h-10"
        placeholder="Search by name or SKU"
        maxLength={200}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
    </form>
  );
}

/** The storefront header (Main board): brand, search, who is signed in, the category bar. */
export function Header({
  shell,
  tree,
  currentTop,
  searchText,
  onSignOut,
}: {
  shell: ShellData;
  tree: CategoryTree;
  /** The top-level category the page is in, underlined in the bar. */
  currentTop: string | undefined;
  searchText?: string;
  onSignOut: () => void;
}) {
  const top = tree.children(null);
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-4 px-4 py-3 md:px-6">
        <Link
          to="/"
          className="flex items-center gap-2.5 text-base font-[650] tracking-[-0.01em] text-foreground no-underline"
        >
          <BrandMark />
          Muziris
        </Link>
        <SearchForm key={searchText ?? ''} initial={searchText ?? ''} />
        <div className="ml-auto flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-full bg-accent text-[11.5px] font-[650] text-accent-foreground"
          >
            {initials(shell.viewer.displayName)}
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-meta font-semibold">{shell.viewer.displayName}</span>
            <span className="text-xs text-muted-foreground">{shell.viewer.customer.name}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
      {top.length > 0 ? (
        <nav className="border-t bg-muted" aria-label="Categories">
          <div className="mx-auto flex max-w-[1280px] gap-0.5 overflow-x-auto px-2 md:px-4">
            {top.map((category) => (
              <Link
                key={category.id}
                to="/c/$categoryId"
                params={{ categoryId: category.id }}
                aria-current={category.id === currentTop ? 'page' : undefined}
                className="inline-flex h-11 items-center rounded-md px-2.5 text-control whitespace-nowrap text-foreground no-underline hover:bg-accent aria-[current=page]:rounded-none aria-[current=page]:font-semibold aria-[current=page]:shadow-[inset_0_-2px_0_var(--primary)] md:h-10"
              >
                {category.name}
              </Link>
            ))}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

export function Footer({ shell }: { shell: ShellData }) {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto flex max-w-[1280px] flex-wrap gap-4 px-6 py-4 text-meta text-muted-foreground">
        <span>{shell.website.name}</span>
        <span>Prices in {shell.website.currency}, excluding GST</span>
      </div>
    </footer>
  );
}
