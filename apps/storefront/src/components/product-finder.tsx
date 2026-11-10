import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { runOperation } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { Search, type SearchResult } from '../operations/generated.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';

/** Fewer characters than this match too much to be useful. */
export const MIN_FINDER_QUERY = 2;
/** The pause after typing before a search is sent. */
const FINDER_DELAY_MS = 250;
const FINDER_RESULTS = 8;

type Found = SearchResult['search']['nodes'][number]['product'];

interface ProductFinderProps {
  /** Called with the product the buyer picked. */
  onPick: (product: Found) => void;
}

/**
 * A search box with suggestions as you type: products the buyer may see, by name or SKU, best
 * match first. A combobox in the ARIA sense, so arrows, Enter and Escape work.
 */
export function ProductFinder({ onPick }: ProductFinderProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; products: Found[] }>();
  const [active, setActive] = useState(-1);
  const [failed, setFailed] = useState(false);
  const latest = useRef('');

  const trimmed = query.trim();
  useEffect(() => {
    latest.current = trimmed;
    // A shorter query shows nothing: results show only for the text in the box.
    if (trimmed.length < MIN_FINDER_QUERY) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      runOperation(Search, { query: trimmed, first: FINDER_RESULTS }, { signal: controller.signal })
        .then(({ search }) => {
          // An answer to an older query is dropped.
          if (latest.current !== trimmed) return;
          setFailed(false);
          setActive(-1);
          setFound({ query: trimmed, products: search.nodes.map((n) => n.product) });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    }, FINDER_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const open = found?.query === trimmed;
  const products = found?.query === trimmed ? found.products : [];

  function pick(product: Found) {
    onPick(product);
    setQuery('');
    setFound(undefined);
    setActive(-1);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && products.length > 0) {
      event.preventDefault();
      setActive((a) => (a + 1) % products.length);
    } else if (event.key === 'ArrowUp' && products.length > 0) {
      event.preventDefault();
      setActive((a) => (a <= 0 ? products.length - 1 : a - 1));
    } else if (event.key === 'Enter') {
      const product = products[active];
      if (product) {
        event.preventDefault();
        pick(product);
      }
    } else if (event.key === 'Escape') {
      setFound(undefined);
      setActive(-1);
    }
  }

  const listId = `${id}-results`;
  const optionId = (index: number) => `${id}-option-${String(index)}`;

  return (
    <div className="relative flex flex-col gap-1.5">
      <Label htmlFor={`${id}-input`}>Find a product</Label>
      <Input
        id={`${id}-input`}
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        placeholder="Name or SKU"
        aria-autocomplete="list"
        aria-expanded={open && products.length > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={handleKey}
      />
      {open && products.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching products"
          className="absolute top-full z-10 m-0 mt-1 w-full list-none overflow-hidden rounded-md border bg-background p-1 shadow-md"
        >
          {products.map((product, index) => (
            <li
              key={product.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={cn(
                'flex cursor-pointer items-baseline gap-3 rounded-sm px-2 py-1.5',
                index === active ? 'bg-muted' : 'hover:bg-muted',
              )}
              // Keeps focus in the box, so the pick lands before the box loses focus.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                pick(product);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {open && products.length === 0 ? (
        <span role="status" className="text-meta text-muted-foreground">
          No products match “{trimmed}”.
        </span>
      ) : null}
      {failed ? (
        <span role="status" className="text-meta text-muted-foreground">
          Suggestions are not available right now. Type the SKU in the box below.
        </span>
      ) : null}
    </div>
  );
}
