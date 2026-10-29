import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, ChevronsLeft } from 'lucide-react';
import { PAGE_SIZE, PAGE_SIZES } from '../lib/endpoints.js';
import { Button } from './ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';

/**
 * Paging under a list (ADR 0010). The API pages by cursor and sends no totals, so there is a
 * first page and a next page, and the browser's back button returns to the previous one.
 */
export function Pager({
  after,
  nextAfter,
  limit,
  shown,
  noun,
}: {
  after: string | undefined;
  nextAfter: string | null;
  limit: number | undefined;
  shown: number;
  noun: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
      <span>
        Showing <b className="num text-foreground">{shown}</b> {noun}
        {after === undefined ? '' : ' on this page'}
      </span>
      <span className="flex-1" />
      <div className="flex items-center gap-2">
        <span id="rows-per-page">Rows per page</span>
        <Select
          value={String(limit ?? PAGE_SIZE)}
          onValueChange={(value) => {
            void navigate({ to: '.', search: { limit: Number(value) } });
          }}
        >
          <SelectTrigger size="sm" className="w-[72px]" aria-labelledby="rows-per-page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav aria-label="Pagination" className="flex items-center gap-1">
        {after === undefined ? (
          <Button variant="outline" size="icon-sm" aria-label="First page" disabled>
            <ChevronsLeft aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="outline" size="icon-sm" asChild>
            <Link to="." search={limit === undefined ? {} : { limit }} aria-label="First page">
              <ChevronsLeft aria-hidden="true" />
            </Link>
          </Button>
        )}
        {nextAfter === null ? (
          <Button variant="outline" size="icon-sm" aria-label="Next page" disabled>
            <ChevronRight aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="outline" size="icon-sm" asChild>
            <Link
              to="."
              search={{ after: nextAfter, ...(limit === undefined ? {} : { limit }) }}
              aria-label="Next page"
            >
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        )}
      </nav>
    </div>
  );
}
