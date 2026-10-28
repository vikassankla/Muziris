import { Link } from '@tanstack/react-router';
import { buttonVariants } from './ui/button.js';

/**
 * Forward paging over an admin list (ADR 0010). The API pages by cursor, so there is a first
 * page and a next page; the browser's back button returns to the previous one.
 */
export function Pager({
  after,
  nextAfter,
}: {
  after: string | undefined;
  nextAfter: string | null;
}) {
  if (after === undefined && nextAfter === null) return null;
  return (
    <nav aria-label="Pages" className="mt-4 flex gap-2">
      {after === undefined ? null : (
        <Link to="." search={{}} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          First page
        </Link>
      )}
      {nextAfter === null ? null : (
        <Link
          to="."
          search={{ after: nextAfter }}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          Next page
        </Link>
      )}
    </nav>
  );
}
