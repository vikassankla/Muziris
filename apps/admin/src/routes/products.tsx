import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Package, Plus } from 'lucide-react';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { NewProductSheet } from '../components/product-sheet.js';
import { EmptyState, NoResults } from '../components/states.js';
import { Badge, Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { flattenCategories } from '../lib/categories.js';
import { listCategories, listProducts, listProductUnits } from '../lib/endpoints.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { authedRoute } from './authed.js';

interface ProductsSearch extends ListSearch {
  categoryId?: string;
  status?: 'enabled' | 'disabled';
}

const ANY = '__any';

export const productsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/products',
  validateSearch: (search: Record<string, unknown>): ProductsSearch => {
    const categoryId = search['categoryId'];
    const status = search['status'];
    return {
      ...listSearch(search),
      ...(typeof categoryId === 'string' && categoryId ? { categoryId } : {}),
      ...(status === 'enabled' || status === 'disabled' ? { status } : {}),
    };
  },
  loaderDeps: ({ search }) => ({
    after: search.after,
    limit: search.limit,
    categoryId: search.categoryId,
    status: search.status,
  }),
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal;
    const [page, categories, units] = await Promise.all([
      listProducts(
        {
          after: deps.after,
          categoryId: deps.categoryId,
          status: deps.status,
          ...(deps.limit === undefined ? {} : { limit: deps.limit }),
        },
        signal,
      ),
      listCategories(signal),
      listProductUnits(signal),
    ]);
    return { page, categories: flattenCategories(categories), units };
  },
  component: ProductsPage,
});

function ProductsPage() {
  const { page, categories, units } = productsRoute.useLoaderData();
  const search = productsRoute.useSearch();
  const navigate = useNavigate();
  const manage = can(useSession(), 'product.manage');
  const path = new Map(categories.map((c) => [c.node.id, c.path]));
  const unitName = new Map(units.map((u) => [u.code, u.name]));
  const filtered = search.categoryId !== undefined || search.status !== undefined;
  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew<ProductsSearch>(open) });
  };
  const filter = (changes: {
    categoryId?: string | undefined;
    status?: 'enabled' | 'disabled' | undefined;
  }) => {
    const next = {
      ...(search.categoryId ? { categoryId: search.categoryId } : {}),
      ...(search.status ? { status: search.status } : {}),
      ...(search.limit ? { limit: search.limit } : {}),
      ...changes,
    };
    void navigate({
      to: '.',
      search: Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined),
      ) as ProductsSearch,
    });
  };
  const newButton = manage ? (
    <Button
      onClick={() => {
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New product
    </Button>
  ) : null;

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Catalog' }, { label: 'Products' }]} />
      <PageHeader
        title="Products"
        description="Everything you sell, with its product units and attributes."
        actions={newButton}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={search.categoryId ?? ANY}
          onValueChange={(value) => {
            filter({ categoryId: value === ANY ? undefined : value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-[200px] rounded-full"
            aria-label="Category filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Every category</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.node.id} value={c.node.id}>
                {c.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.status ?? ANY}
          onValueChange={(value) => {
            filter({ status: value === ANY ? undefined : (value as 'enabled' | 'disabled') });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-[150px] rounded-full"
            aria-label="Status filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
        {filtered ? (
          <Button variant="ghost" size="sm" asChild>
            <Link to="." search={{}}>
              Clear filters
            </Link>
          </Button>
        ) : null}
      </div>
      {page.items.length === 0 && search.after === undefined ? (
        filtered ? (
          <NoResults
            title="No products match these filters"
            description="Choose another category or status, or clear the filters."
            onClear={() => void navigate({ to: '.', search: {} })}
          />
        ) : (
          <EmptyState
            icon={Package}
            title="No products yet"
            description="Add the products you sell. Create their product units first."
            action={newButton ?? undefined}
          />
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead aria-sort="ascending">SKU</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Primary unit</TableHead>
                <TableHead>Type</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {page.items.map((product) => (
                <TableRow key={product.id}>
                  <TableCell>
                    <Link
                      to="/products/$productId"
                      params={{ productId: product.id }}
                      className="font-mono text-[12.5px] font-[550] text-foreground hover:underline"
                    >
                      {product.sku}
                    </Link>
                  </TableCell>
                  <TableCell className="min-w-[220px] whitespace-normal">{product.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {product.categoryId ? (path.get(product.categoryId) ?? '') : 'None'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={product.status === 'enabled' ? 'success' : 'neutral'}>
                      {product.status === 'enabled' ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {unitName.get(product.primaryUnitCode) ?? product.primaryUnitCode}
                  </TableCell>
                  <TableCell>
                    <Tag>{product.type === 'simple' ? 'Simple' : product.type}</Tag>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            after={search.after}
            nextAfter={page.nextAfter}
            limit={search.limit}
            shown={page.items.length}
            noun="products"
          />
        </>
      )}
      {manage ? (
        <NewProductSheet
          open={search.new === true}
          onOpenChange={setNew}
          categories={categories}
          units={units}
          onCreated={(product) => {
            void navigate({ to: '/products/$productId', params: { productId: product.id } });
          }}
        />
      ) : null}
    </Page>
  );
}
