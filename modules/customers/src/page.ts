import { z } from 'zod';

// Admin lists are read a page at a time. A page is ordered by a key that ends in the row's id,
// so it is total, and `after` is the id of the previous page's last row: the next page starts
// strictly after that row's key. An `after` id that matches no row gives an empty page.

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export const pageQuerySchema = z.object({
  /** Continue after this id, from the previous page's nextAfter. */
  after: z.uuid().optional(),
  limit: z.int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});

export type PageQuery = z.input<typeof pageQuerySchema>;

/**
 * Cuts the rows of a query that asked for `limit + 1` rows down to one page. The extra row only
 * says whether another page exists.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  idOf: (row: T) => string,
): { items: T[]; nextAfter: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextAfter: rows.length > limit && last !== undefined ? idOf(last) : null };
}
