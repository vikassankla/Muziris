import { createRoute, useNavigate } from '@tanstack/react-router';
import { useState, type ChangeEvent } from 'react';
import { ErrorState } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input, Select } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { runOperation } from '../lib/api.js';
import { handToCheckout } from '../lib/checkout.js';
import { formatPrice } from '../lib/format.js';
import { signInOn401 } from '../lib/guard.js';
import {
  checkRows,
  MAX_QUICK_ORDER_ROWS,
  parseQuickOrder,
  skuBatches,
  type CheckedRow,
  type ParsedQuickOrder,
  type QuickOrderProduct,
} from '../lib/quick-order.js';
import {
  AddShoppingListLines,
  CreateShoppingList,
  ProductsBySkus,
  ShoppingLists,
} from '../operations/generated.js';
import { authedRoute } from './authed.js';

/** The largest CSV file read, well above 500 rows of SKU, quantity and unit. */
const MAX_FILE_BYTES = 256 * 1024;
const NEW_LIST = 'new';

export const quickOrderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/quick-order',
  loader: async ({ location, abortController }) => {
    try {
      // The lists to add to: the 50 most recently changed are enough to pick from.
      return await runOperation(ShoppingLists, { first: 50 }, { signal: abortController.signal });
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: QuickOrderPage,
});

interface Checked {
  parsed: ParsedQuickOrder;
  rows: CheckedRow[];
}

function QuickOrderPage() {
  const { shoppingLists } = quickOrderRoute.useLoaderData();
  const { shell } = authedRoute.useRouteContext();
  const { locale } = shell.website;
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<Checked>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message?: string; error?: unknown }>();
  const [target, setTarget] = useState(shoppingLists.nodes[0]?.id ?? NEW_LIST);
  const [newName, setNewName] = useState('');

  const good = checked?.rows.filter((r) => r.ok) ?? [];
  const bad = (checked?.rows.length ?? 0) - good.length;
  const lines = good.map((r) => ({
    productId: r.product.id,
    unitCode: r.unit.code,
    quantity: r.quantity,
  }));

  async function check() {
    const parsed = parseQuickOrder(text);
    setBusy(true);
    setFailure(undefined);
    try {
      const products: QuickOrderProduct[] = [];
      for (const skus of skuBatches(parsed.rows)) {
        const { productsBySkus } = await runOperation(ProductsBySkus, { skus });
        products.push(...productsBySkus.products);
      }
      setChecked({ parsed, rows: checkRows(parsed.rows, products) });
    } catch (error) {
      setChecked(undefined);
      setFailure({ error });
    } finally {
      setBusy(false);
    }
  }

  function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFailure({ message: 'That file is too large. Upload a CSV of at most 500 rows.' });
      return;
    }
    // Read in the browser only; the file is never uploaded.
    void file.text().then((contents) => {
      setText(contents);
      setChecked(undefined);
      setFailure(undefined);
    });
  }

  async function addToList() {
    setBusy(true);
    setFailure(undefined);
    try {
      let listId = target;
      if (target === NEW_LIST) {
        const { createShoppingList } = await runOperation(CreateShoppingList, {
          name: newName.trim(),
        });
        if (!createShoppingList.list) {
          setFailure({ message: createShoppingList.refusal?.message ?? 'The list was not made.' });
          return;
        }
        listId = createShoppingList.list.id;
      }
      const { addShoppingListLines } = await runOperation(AddShoppingListLines, { listId, lines });
      if (addShoppingListLines.refusal) {
        const [first] = addShoppingListLines.refusal.lines;
        const row = first === undefined ? undefined : good[first.index]?.row;
        setFailure({
          message:
            row && first
              ? `Line ${String(row.line)} (${row.sku}): ${first.message}`
              : addShoppingListLines.refusal.message,
        });
        return;
      }
      await navigate({ to: '/lists/$listId', params: { listId }, search: {} });
    } catch (error) {
      setFailure({ error });
    } finally {
      setBusy(false);
    }
  }

  function goToCheckout() {
    handToCheckout(lines);
    void navigate({ to: '/checkout', search: {} });
  }

  return (
    <>
      <div>
        <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">Quick order</h1>
        <p className="m-0 mt-1 text-muted-foreground">
          Paste SKUs and quantities, or upload a CSV, then add them to a list or check out.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-order-text">Items</Label>
            <textarea
              id="quick-order-text"
              className="min-h-[160px] w-full rounded-md border border-input bg-background p-2.5 font-mono text-[13px] focus-visible:border-ring focus-visible:outline-none"
              placeholder={'HB-M8-40, 400\nWA-M8\t200\nNUT-M8 10 BOX'}
              spellCheck={false}
              value={text}
              aria-describedby="quick-order-hint"
              onChange={(event) => {
                setText(event.target.value);
                setChecked(undefined);
              }}
            />
            <span id="quick-order-hint" className="text-meta text-muted-foreground">
              One item per line: SKU, then quantity, then an optional unit code, split by a tab, a
              comma or spaces. At most {MAX_QUICK_ORDER_ROWS} lines.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || text.trim() === ''} onClick={() => void check()}>
              Check items
            </Button>
            <label className="text-meta text-muted-foreground">
              <span className="mr-2">Or upload a CSV</span>
              <input type="file" accept=".csv,text/csv,text/plain" onChange={readFile} />
            </label>
          </div>
          {failure?.message ? <Alert variant="warning">{failure.message}</Alert> : null}
          {failure?.error ? <ErrorState error={failure.error} /> : null}
        </CardContent>
      </Card>
      {checked ? (
        <Card>
          <CardHeader>
            <CardTitle>Checked items</CardTitle>
            <span className="flex-1" />
            <span className="text-meta text-muted-foreground">
              {good.length} ready
              {bad > 0 ? `, ${String(bad)} with problems left out` : ''}
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {checked.parsed.problems.map((p) => (
              <Alert key={p.line} variant="warning">
                Line {p.line}: {p.message}
              </Alert>
            ))}
            {checked.rows.length > 0 ? (
              <Table>
                <TableHeader>
                  <tr>
                    <TableHead>Line</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead className="text-right">Price for 1</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {checked.rows.map((r) => (
                    <TableRow key={r.row.line}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {r.row.line}
                      </TableCell>
                      <TableCell className="min-w-[220px] whitespace-normal">
                        <div className="font-[550]">{r.product?.name ?? r.row.sku}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.row.sku}</div>
                        {r.ok ? null : (
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive-text">
                            <Badge variant="destructive">Problem</Badge>
                            {r.message}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {r.ok ? `${r.quantity} ${r.unit.name}` : r.row.quantity}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {r.ok && r.product.price && r.unit.code === r.product.units[0]?.code
                          ? formatPrice(r.product.price.unitPrice, locale)
                          : r.ok
                            ? 'At checkout'
                            : ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            {good.length > 0 ? (
              <p className="m-0 text-xs text-muted-foreground">
                Prices are for one primary unit. Quantity breaks apply at checkout.
              </p>
            ) : null}
            {good.length > 0 ? (
              <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                <div className="flex min-w-[200px] flex-col gap-1.5">
                  <Label htmlFor="target-list">Shopping list</Label>
                  <Select
                    id="target-list"
                    value={target}
                    onChange={(event) => {
                      setTarget(event.target.value);
                    }}
                  >
                    {shoppingLists.nodes.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                    <option value={NEW_LIST}>New list…</option>
                  </Select>
                </div>
                {target === NEW_LIST ? (
                  <div className="flex min-w-[200px] flex-col gap-1.5">
                    <Label htmlFor="new-list-name">List name</Label>
                    <Input
                      id="new-list-name"
                      maxLength={100}
                      value={newName}
                      onChange={(event) => {
                        setNewName(event.target.value);
                      }}
                    />
                  </div>
                ) : null}
                <Button
                  variant="outline"
                  disabled={busy || (target === NEW_LIST && newName.trim() === '')}
                  onClick={() => void addToList()}
                >
                  Add to shopping list
                </Button>
                <span className="flex-1" />
                <Button disabled={busy} onClick={goToCheckout}>
                  Go to checkout
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
