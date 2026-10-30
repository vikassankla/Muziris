import { createRoute, Link } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { ProductList } from '../components/product-list.js';
import { EmptyState } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { buttonVariants } from '../components/ui/button.js';
import { runOperation } from '../lib/api.js';
import { signInOn401 } from '../lib/guard.js';
import { Search, type SearchResult } from '../operations/generated.js';
import { authedRoute } from './authed.js';

export const SEARCH_PAGE_SIZE = 20;

type Match = SearchResult['search']['nodes'][number]['match'];

export const MATCH_LABELS: Record<Match, string> = {
  SKU_EXACT: 'SKU',
  SKU_PREFIX: 'SKU starts with',
  TEXT: 'Name or details',
  CLOSE: 'Close spelling',
};

interface SearchSearch {
  q: string;
  offset?: number;
}

export const searchRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/search',
  validateSearch: (search: Record<string, unknown>): SearchSearch => {
    const q = typeof search['q'] === 'string' ? search['q'].trim().slice(0, 200) : '';
    const offset = Number(search['offset']);
    return {
      q,
      ...(Number.isInteger(offset) && offset > 0 && offset < 1000 ? { offset } : {}),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, location, abortController }) => {
    if (deps.q === '') return undefined;
    try {
      return await runOperation(
        Search,
        { query: deps.q, first: SEARCH_PAGE_SIZE, offset: deps.offset ?? 0 },
        { signal: abortController.signal },
      );
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: SearchPage,
});

function SearchPage() {
  const data = searchRoute.useLoaderData();
  const { q, offset = 0 } = searchRoute.useSearch();
  const { shell } = authedRoute.useRouteContext();

  if (data === undefined) {
    return (
      <EmptyState title="Search the catalogue">
        Type a SKU, a product name or a detail such as a size in the search box.
      </EmptyState>
    );
  }
  const hits = data.search.nodes;
  if (hits.length === 0) {
    return (
      <EmptyState title={`No results for “${q}”`}>
        Check the SKU or try fewer words. Searches cover SKUs, product names and details.
      </EmptyState>
    );
  }
  const onlyClose = hits.every((hit) => hit.match === 'CLOSE');
  const prev = Math.max(0, offset - SEARCH_PAGE_SIZE);

  return (
    <>
      <div>
        <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">Results for “{q}”</h1>
        <p className="m-0 mt-1 text-muted-foreground">
          Best matches first: exact SKU, then SKUs starting with your text, then names and details,
          then close spellings.
        </p>
      </div>
      {onlyClose && offset === 0 ? (
        <Alert variant="info" icon={<Info />}>
          No exact match for “{q}”. Showing close spellings.
        </Alert>
      ) : null}
      <ProductList
        products={hits.map((hit) => hit.product)}
        locale={shell.website.locale}
        extra={{
          heading: 'Match',
          cell: (index) => {
            const hit = hits[index];
            return hit ? (
              <Badge variant="default" dot={false}>
                {MATCH_LABELS[hit.match]}
              </Badge>
            ) : null;
          },
        }}
      />
      <nav
        className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground"
        aria-label="Pages"
      >
        <span>
          Results {offset + 1} to {offset + hits.length}
        </span>
        <span className="flex-1" />
        {offset > 0 ? (
          <Link
            to="/search"
            search={{ q, ...(prev > 0 ? { offset: prev } : {}) }}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Previous
          </Link>
        ) : null}
        {data.search.nextOffset !== null ? (
          <Link
            to="/search"
            search={{ q, offset: data.search.nextOffset }}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Next
          </Link>
        ) : null}
      </nav>
    </>
  );
}
