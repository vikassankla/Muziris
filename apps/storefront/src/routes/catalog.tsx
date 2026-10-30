import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Fragment } from 'react';
import { ProductList } from '../components/product-list.js';
import { EmptyCategory, EmptyState } from '../components/states.js';
import { buttonVariants } from '../components/ui/button.js';
import { runOperation } from '../lib/api.js';
import type { Category, CategoryTree } from '../lib/categories.js';
import { signInOn401 } from '../lib/guard.js';
import { Products } from '../operations/generated.js';
import { authedRoute } from './authed.js';

/** Products per page; the API allows up to 50 (ADR 0014). */
export const PAGE_SIZE = 20;

interface CatalogSearch {
  after?: string;
  /** Leave out subcategories; they are included unless this is set. */
  only?: true;
}

function validateSearch(search: Record<string, unknown>): CatalogSearch {
  const after = search['after'];
  return {
    ...(typeof after === 'string' && after.length > 0 && after.length <= 64 ? { after } : {}),
    ...(search['only'] === true || search['only'] === 'true' ? { only: true as const } : {}),
  };
}

async function loadPage(
  categoryId: string | undefined,
  search: CatalogSearch,
  href: string,
  signal: AbortSignal,
) {
  try {
    return await runOperation(
      Products,
      {
        categoryId: categoryId ?? null,
        includeSubcategories: categoryId !== undefined && search.only !== true,
        first: PAGE_SIZE,
        after: search.after ?? null,
      },
      { signal },
    );
  } catch (error) {
    return signInOn401(error, href);
  }
}

export const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  validateSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, location, abortController }) =>
    loadPage(undefined, deps, location.href, abortController.signal),
  component: function HomePage() {
    const data = homeRoute.useLoaderData();
    const search = homeRoute.useSearch();
    const { shell } = authedRoute.useRouteContext();
    return (
      <>
        <div>
          <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">All products</h1>
          <p className="m-0 mt-1 text-muted-foreground">
            Prices are your prices for {shell.viewer.customer.name}, in {shell.website.currency},
            excluding GST.
          </p>
        </div>
        {data.products.nodes.length === 0 ? (
          <EmptyState title="No products yet">
            There are no products you can order yet. Contact your account manager.
          </EmptyState>
        ) : (
          <ProductList products={data.products.nodes} locale={shell.website.locale} />
        )}
        <Pager
          count={data.products.nodes.length}
          nextAfter={data.products.nextAfter}
          paged={search.after !== undefined}
          to="/"
        />
      </>
    );
  },
});

export const categoryRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/c/$categoryId',
  validateSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps, location, abortController }) =>
    loadPage(params.categoryId, deps, location.href, abortController.signal),
  component: CategoryPage,
});

function Pager({
  count,
  nextAfter,
  paged,
  to,
  categoryId,
  only,
}: {
  count: number;
  nextAfter: string | null;
  paged: boolean;
  to: '/' | '/c/$categoryId';
  categoryId?: string;
  only?: true;
}) {
  if (!paged && nextAfter === null) return null;
  const params = { categoryId: categoryId ?? '' };
  const keep = only ? { only } : {};
  return (
    <nav
      className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground"
      aria-label="Pages"
    >
      <span>Showing {count} products, by SKU</span>
      <span className="flex-1" />
      {paged ? (
        <Link
          to={to}
          params={params}
          search={keep}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          First page
        </Link>
      ) : null}
      {nextAfter !== null ? (
        <Link
          to={to}
          params={params}
          search={{ ...keep, after: nextAfter }}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          Next
        </Link>
      ) : null}
    </nav>
  );
}

/** The side menu (Main board): the top category's children, opening along the current path. */
function SideMenu({ tree, path }: { tree: CategoryTree; path: readonly Category[] }) {
  const [top] = path;
  if (!top) return null;
  const onPath = new Set(path.map((c) => c.id));
  const current = path.at(-1)?.id;
  const item = (category: Category, label: string, sub: boolean) => (
    <Link
      to="/c/$categoryId"
      params={{ categoryId: category.id }}
      aria-current={category.id === current ? 'page' : undefined}
      className={`flex min-h-9 items-center rounded-md px-2.5 text-control text-foreground no-underline hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground ${sub ? 'pl-6' : ''}`}
    >
      {label}
    </Link>
  );
  return (
    <nav
      className="flex w-full flex-col gap-1 md:w-auto md:max-w-[280px] md:flex-[1_1_220px]"
      aria-label={top.name}
    >
      <div className="px-2.5 pt-1 pb-1.5 text-[11.5px] font-semibold tracking-[.04em] text-muted-foreground uppercase">
        {top.name}
      </div>
      {item(top, `All ${top.name.toLowerCase()}`, false)}
      {tree.children(top.id).map((child) => (
        <Fragment key={child.id}>
          {item(child, child.name, false)}
          {onPath.has(child.id)
            ? tree
                .children(child.id)
                .map((grandchild) => (
                  <Fragment key={grandchild.id}>{item(grandchild, grandchild.name, true)}</Fragment>
                ))
            : null}
        </Fragment>
      ))}
    </nav>
  );
}

function CategoryPage() {
  const data = categoryRoute.useLoaderData();
  const search = categoryRoute.useSearch();
  const { categoryId } = categoryRoute.useParams();
  const { shell, tree } = authedRoute.useRouteContext();
  const navigate = useNavigate();
  const category = tree.get(categoryId);

  if (!category) {
    return (
      <EmptyState
        title="We can’t find that category"
        action={
          <Link to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            All products
          </Link>
        }
      >
        It may have been removed, or it isn’t in your company’s catalogue.
      </EmptyState>
    );
  }
  const path = tree.path(categoryId);
  const hasChildren = tree.children(categoryId).length > 0;

  return (
    <>
      <nav
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground"
        aria-label="Breadcrumb"
      >
        <Link to="/" className="text-inherit no-underline hover:text-foreground hover:underline">
          All products
        </Link>
        {path.map((c) => (
          <Fragment key={c.id}>
            <span aria-hidden="true">/</span>
            {c.id === categoryId ? (
              <span aria-current="page" className="text-foreground">
                {c.name}
              </span>
            ) : (
              <Link
                to="/c/$categoryId"
                params={{ categoryId: c.id }}
                className="text-inherit no-underline hover:text-foreground hover:underline"
              >
                {c.name}
              </Link>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="flex flex-wrap items-start gap-6">
        <SideMenu tree={tree} path={path} />
        <section
          className="flex min-w-0 flex-[999_1_560px] flex-col gap-4"
          aria-labelledby="category-title"
        >
          <div className="flex flex-wrap items-start gap-4">
            <div>
              <h1
                id="category-title"
                className="m-0 text-page-title font-[650] tracking-[-0.015em]"
              >
                {category.name}
              </h1>
              <p className="m-0 mt-1 text-muted-foreground">
                Prices are your prices for {shell.viewer.customer.name}, in {shell.website.currency}
                , excluding GST.
              </p>
            </div>
            {hasChildren ? (
              <label className="ml-auto flex min-h-11 items-center gap-2 text-meta">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={search.only !== true}
                  onChange={(event) => {
                    void navigate({
                      to: '/c/$categoryId',
                      params: { categoryId },
                      search: event.target.checked ? {} : { only: true },
                    });
                  }}
                />
                Include subcategories
              </label>
            ) : null}
          </div>
          {data.products.nodes.length === 0 ? (
            <EmptyCategory
              name={category.name}
              action={
                <Link to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  All products
                </Link>
              }
            />
          ) : (
            <ProductList products={data.products.nodes} locale={shell.website.locale} />
          )}
          <Pager
            count={data.products.nodes.length}
            nextAfter={data.products.nextAfter}
            paged={search.after !== undefined}
            to="/c/$categoryId"
            categoryId={categoryId}
            {...(search.only ? { only: search.only } : {})}
          />
        </section>
      </div>
    </>
  );
}
