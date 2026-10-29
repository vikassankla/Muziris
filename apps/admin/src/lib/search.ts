import { PAGE_SIZES } from './endpoints.js';

export interface ListSearch {
  /** Cursor from the previous page's nextAfter. */
  after?: string;
  /** Page size: 25, 50 or 100. */
  limit?: number;
  /** Opens the list's create form, from the command palette. */
  new?: boolean;
}

/** Reads a list screen's search string, dropping anything unexpected. */
export function listSearch(search: Record<string, unknown>): ListSearch {
  const out: ListSearch = {};
  const after = search['after'];
  if (typeof after === 'string' && after.length > 0 && after.length <= 100) out.after = after;
  const limit = Number(search['limit']);
  if ((PAGE_SIZES as readonly number[]).includes(limit)) out.limit = limit;
  if (search['new'] === true || search['new'] === 'true') out.new = true;
  return out;
}

/** The same search with the create form opened or closed, for navigate({ search }). */
export function withNew<T extends ListSearch>(open: boolean): (prev: T) => T {
  return (prev) => {
    const rest = { ...prev };
    delete rest.new;
    return open ? { ...rest, new: true } : rest;
  };
}
