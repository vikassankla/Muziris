import { createRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/page-header.js';
import { Pager } from '../components/pager.js';
import { Badge } from '../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { listCategories, listProducts, type CategoryNode } from '../lib/endpoints.js';
import { listSearch as afterSearch } from '../lib/search.js';
import { authedRoute } from './authed.js';

export const productsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/products',
  validateSearch: afterSearch,
  loaderDeps: ({ search }) => ({ after: search.after }),
  loader: ({ deps, abortController }) =>
    listProducts({ after: deps.after }, abortController.signal),
  component: ProductsPage,
});

function ProductsPage() {
  const page = productsRoute.useLoaderData();
  const { after } = productsRoute.useSearch();
  return (
    <div>
      <PageHeader title="Products">Every product by SKU.</PageHeader>
      {page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Product units</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((product) => (
              <TableRow key={product.id}>
                <TableCell className="font-mono text-xs">{product.sku}</TableCell>
                <TableCell className="font-medium">{product.name}</TableCell>
                <TableCell>
                  <Badge variant={product.status === 'enabled' ? 'default' : 'outline'}>
                    {product.status === 'enabled' ? 'Enabled' : 'Disabled'}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {product.units.map((unit) => unit.name).join(', ')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager
        after={after}
        nextAfter={page.nextAfter}
        limit={undefined}
        shown={page.items.length}
        noun="rows"
      />
    </div>
  );
}

export const categoriesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/categories',
  loader: ({ abortController }) => listCategories(abortController.signal),
  component: CategoriesPage,
});

function CategoryTree({ nodes }: { nodes: CategoryNode[] }) {
  return (
    <ul className="ml-4 border-l pl-4">
      {nodes.map((node) => (
        <li key={node.id} className="py-1">
          <span className="font-medium">{node.name}</span>{' '}
          <span className="font-mono text-xs text-muted-foreground">{node.code}</span>
          {node.children.length > 0 ? <CategoryTree nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

function CategoriesPage() {
  const categories = categoriesRoute.useLoaderData();
  return (
    <div>
      <PageHeader title="Categories">The category tree in display order.</PageHeader>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <CategoryTree nodes={categories} />
      )}
    </div>
  );
}
