import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { formatPrice } from '../lib/format.js';
import type { ProductsResult } from '../operations/generated.js';
import { Card } from './ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

/** A product as lists show it: Products.graphql and Search.graphql select the same fields. */
export type ProductRow = ProductsResult['products']['nodes'][number];

export const PRICE_ON_REQUEST = 'Price on request';

/** The buyer's price for one primary unit, or "Price on request" when there is none. */
export function RowPrice({ product, locale }: { product: ProductRow; locale: string }) {
  if (!product.price)
    return <span className="text-meta text-muted-foreground">{PRICE_ON_REQUEST}</span>;
  return (
    <>
      <span className="num text-[15px] font-[650]">
        {formatPrice(product.price.unitPrice, locale)}
      </span>{' '}
      <span className="text-meta text-muted-foreground">
        / {product.primaryUnit.name.toLowerCase()}
      </span>
    </>
  );
}

/**
 * Products as a table, and as cards at phone width (Main and Mobile boards). `extra` adds a
 * column, such as the search match.
 */
export function ProductList({
  products,
  locale,
  extra,
}: {
  products: readonly ProductRow[];
  locale: string;
  extra?: { heading: string; cell: (index: number) => ReactNode };
}) {
  return (
    <>
      <Table className="hidden md:table" aria-label="Products">
        <TableHeader>
          <tr>
            <TableHead>SKU</TableHead>
            <TableHead>Product</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Unit</TableHead>
            {extra ? <TableHead>{extra.heading}</TableHead> : null}
            <TableHead className="text-right">Your price</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {products.map((product, index) => (
            <TableRow key={product.id}>
              <TableCell>
                <Link
                  to="/p/$sku"
                  params={{ sku: product.sku }}
                  className="font-mono text-[12.5px] font-[550] text-foreground no-underline hover:underline"
                >
                  {product.sku}
                </Link>
              </TableCell>
              <TableCell className="min-w-60 whitespace-normal">
                <Link
                  to="/p/$sku"
                  params={{ sku: product.sku }}
                  className="font-[550] text-foreground no-underline hover:underline"
                >
                  {product.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {product.category?.name ?? ''}
              </TableCell>
              <TableCell className="text-muted-foreground">{product.primaryUnit.name}</TableCell>
              {extra ? <TableCell>{extra.cell(index)}</TableCell> : null}
              <TableCell className="text-right">
                <RowPrice product={product} locale={locale} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden" aria-label="Products">
        {products.map((product) => (
          <li key={product.id}>
            <Card className="p-0">
              <Link
                to="/p/$sku"
                params={{ sku: product.sku }}
                className="flex min-h-16 items-center gap-3 px-3.5 py-3 text-inherit no-underline"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-meta font-semibold">{product.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
                </span>
                <span className="text-right">
                  <RowPrice product={product} locale={locale} />
                </span>
              </Link>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
