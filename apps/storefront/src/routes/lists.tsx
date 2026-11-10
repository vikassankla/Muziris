import { createRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { ListChecks, ListX } from 'lucide-react';
import { useEffect, useState, type SubmitEvent } from 'react';
import { ListPicker } from '../components/list-picker.js';
import { ErrorState, EmptyState } from '../components/states.js';
import { Alert } from '../components/ui/alert.js';
import { Tag } from '../components/ui/badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
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
import { checkQuantity, formatPrice, lineTotal } from '../lib/format.js';
import { signInOn401 } from '../lib/guard.js';
import { formatDateTime } from '../lib/orders.js';
import { NEW_LIST } from '../lib/shopping-lists.js';
import {
  CreateShoppingList,
  DeleteShoppingList,
  DuplicateShoppingList,
  MoveShoppingListLines,
  RemoveShoppingListLines,
  RenameShoppingList,
  ShoppingList,
  ShoppingLists,
  UpdateShoppingListLine,
  type ShoppingListResult,
} from '../operations/generated.js';
import { authedRoute } from './authed.js';

export const LISTS_PAGE_SIZE = 20;

interface PageSearch {
  after?: string;
}

function validatePage(search: Record<string, unknown>): PageSearch {
  const after = search['after'];
  return typeof after === 'string' && after.length > 0 && after.length <= 200 ? { after } : {};
}

/** A list change's answer: the list, or a refusal whose message is safe to show. */
interface Change {
  list?: { id: string } | null;
  refusal?: { message: string } | null;
}

export const listsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/lists',
  validateSearch: validatePage,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, location, abortController }) => {
    try {
      return await runOperation(
        ShoppingLists,
        { first: LISTS_PAGE_SIZE, ...(deps.after ? { after: deps.after } : {}) },
        { signal: abortController.signal },
      );
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: ListsPage,
});

function ListsPage() {
  const data = listsRoute.useLoaderData();
  const { after } = listsRoute.useSearch();
  const { shell } = authedRoute.useRouteContext();
  const { locale, timeZone } = shell.website;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message?: string; error?: unknown }>();
  const lists = data.shoppingLists.nodes;

  async function handleCreate(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      const { createShoppingList } = await runOperation(CreateShoppingList, { name: trimmed });
      if (createShoppingList.list) {
        await navigate({ to: '/lists/$listId', params: { listId: createShoppingList.list.id } });
      } else {
        setFailure({ message: createShoppingList.refusal?.message ?? 'The list was not made.' });
      }
    } catch (error) {
      setFailure({ error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">Shopping lists</h1>
          <p className="m-0 mt-1 text-muted-foreground">
            Lists you may see for {shell.viewer.customer.name}, most recently changed first.
          </p>
        </div>
        <Link to="/quick-order" className={buttonVariants({ variant: 'outline' })}>
          Quick order
        </Link>
      </div>
      <Card>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => void handleCreate(event)}
          >
            <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
              <Label htmlFor="new-list">New list</Label>
              <Input
                id="new-list"
                maxLength={100}
                placeholder="For example, Monthly maintenance"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            <Button type="submit" disabled={busy || name.trim() === ''}>
              Make list
            </Button>
          </form>
          {failure?.message ? (
            <Alert variant="warning" className="mt-3">
              {failure.message}
            </Alert>
          ) : null}
          {failure?.error ? (
            <div className="mt-3">
              <ErrorState error={failure.error} />
            </div>
          ) : null}
        </CardContent>
      </Card>
      {lists.length === 0 && after === undefined ? (
        <EmptyState icon={<ListChecks />} title="No shopping lists yet">
          Make a list for products you order often, or add rows to one from quick order.
        </EmptyState>
      ) : (
        <>
          <Table>
            <TableHeader>
              <tr>
                <TableHead>List</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead>Changed</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {lists.map((list) => (
                <TableRow key={list.id}>
                  <TableCell>
                    <Link
                      to="/lists/$listId"
                      params={{ listId: list.id }}
                      className="font-[550] text-foreground hover:underline"
                    >
                      {list.name}
                    </Link>
                    {list.isOwn ? null : <Tag className="ml-2">Shared</Tag>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{list.lineCount}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(list.updatedAt, locale, timeZone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav className="flex flex-wrap items-center gap-3" aria-label="Pages">
            <span className="flex-1" />
            {after !== undefined ? (
              <Link
                to="/lists"
                search={{}}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Newest
              </Link>
            ) : null}
            {data.shoppingLists.nextAfter !== null ? (
              <Link
                to="/lists"
                search={{ after: data.shoppingLists.nextAfter }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Older
              </Link>
            ) : null}
          </nav>
        </>
      )}
    </>
  );
}

export const listRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/lists/$listId',
  validateSearch: validatePage,
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps, location, abortController }) => {
    try {
      return await runOperation(
        ShoppingList,
        { id: params.listId, ...(deps.after ? { after: deps.after } : {}) },
        { signal: abortController.signal },
      );
    } catch (error) {
      return signInOn401(error, location.href);
    }
  },
  component: ListPage,
});

type List = NonNullable<ShoppingListResult['shoppingList']>;
type Line = List['lines']['nodes'][number];

function ListPage() {
  const { shoppingList: list } = listRoute.useLoaderData();
  const { after } = listRoute.useSearch();
  const router = useRouter();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<{ message?: string; error?: unknown }>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [targets, setTargets] = useState<{ id: string; name: string }[]>();
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [moved, setMoved] = useState<{ listId: string; name: string; count: number }>();
  const anySelected = selected.size > 0;
  const shownId = list?.id;

  // The lists to move to: loaded once, when the buyer first selects a line.
  useEffect(() => {
    if (!anySelected || targets !== undefined) return;
    const controller = new AbortController();
    runOperation(ShoppingLists, { first: 50 }, { signal: controller.signal })
      .then(({ shoppingLists }) => {
        const others = shoppingLists.nodes.filter((l) => l.id !== shownId);
        setTargets(others);
        setTarget((current) => current || (others[0]?.id ?? NEW_LIST));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem({ error });
      });
    return () => {
      controller.abort();
    };
  }, [anySelected, targets, shownId]);

  if (list === null) {
    return (
      <EmptyState
        icon={<ListX />}
        title="We can't find that list"
        action={
          <Link to="/lists" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Back to lists
          </Link>
        }
      >
        It may have been deleted. You see only the lists your role allows.
      </EmptyState>
    );
  }
  const listId = list.id;

  /** Runs a change, then reloads the list; a refusal or failure is shown above the lines. */
  async function act(run: () => Promise<Change>, after?: (result: Change) => Promise<void>) {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await run();
      const message = result.refusal?.message;
      if (message !== undefined) setProblem({ message });
      else if (after) await after(result);
      else await router.invalidate();
    } catch (error) {
      setProblem({ error });
    } finally {
      setBusy(false);
    }
  }

  function rename() {
    const name = window.prompt('Rename the list', list?.name)?.trim();
    if (!name) return;
    void act(
      async () => (await runOperation(RenameShoppingList, { listId, name })).renameShoppingList,
    );
  }

  function duplicate() {
    const name = window.prompt('Name the copy', `${list?.name ?? ''} (copy)`)?.trim();
    if (!name) return;
    void act(
      async () =>
        (await runOperation(DuplicateShoppingList, { listId, name })).duplicateShoppingList,
      async (result) => {
        if (result.list) {
          await navigate({ to: '/lists/$listId', params: { listId: result.list.id }, search: {} });
        }
      },
    );
  }

  function remove() {
    if (!window.confirm(`Delete “${list?.name ?? ''}” and its lines? This can’t be undone.`))
      return;
    void act(
      async () => (await runOperation(DeleteShoppingList, { listId })).deleteShoppingList,
      async () => {
        await navigate({ to: '/lists', search: {} });
      },
    );
  }

  const available = list.lines.nodes.filter((line) => line.product !== null);
  const chosen = list.lines.nodes.filter((line) => selected.has(line.id)).map((line) => line.id);
  const allChosen = chosen.length > 0 && chosen.length === list.lines.nodes.length;

  function toggle(lineId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
  }

  /** Moves the selected lines to the picked list, making it first when it is new. */
  async function move() {
    const count = chosen.length;
    setBusy(true);
    setProblem(undefined);
    setMoved(undefined);
    try {
      let toListId = target;
      let toName = targets?.find((t) => t.id === target)?.name ?? '';
      if (target === NEW_LIST) {
        const { createShoppingList } = await runOperation(CreateShoppingList, {
          name: newName.trim(),
        });
        const made = createShoppingList.list;
        if (!made) {
          setProblem({ message: createShoppingList.refusal?.message ?? 'The list was not made.' });
          return;
        }
        toListId = made.id;
        toName = made.name;
        setTargets((current) => [...(current ?? []), { id: made.id, name: made.name }]);
        setTarget(made.id);
        setNewName('');
      }
      const { moveShoppingListLines } = await runOperation(MoveShoppingListLines, {
        fromListId: listId,
        toListId,
        lineIds: chosen,
      });
      if (moveShoppingListLines.refusal) {
        setProblem({ message: moveShoppingListLines.refusal.message });
        return;
      }
      setSelected(new Set());
      setMoved({ listId: toListId, name: moveShoppingListLines.list?.name ?? toName, count });
      await router.invalidate();
    } catch (error) {
      setProblem({ error });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <Link to="/lists" className="text-meta text-muted-foreground">
          Shopping lists
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-page-title font-[650] tracking-[-0.015em]">{list.name}</h1>
          {list.isOwn ? null : <Tag>Shared</Tag>}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" disabled={busy} onClick={rename}>
            Rename
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={duplicate}>
            Duplicate
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
            Delete
          </Button>
          {list.lineCount > 0 ? (
            <Link
              to="/checkout"
              search={{ list: listId }}
              className={buttonVariants({ variant: 'default' })}
            >
              Check out this list
            </Link>
          ) : null}
        </div>
        <p className="m-0 mt-1 text-muted-foreground">
          {list.lineCount === 1 ? '1 line' : `${String(list.lineCount)} lines`}. Prices are your
          prices today, excluding GST.
        </p>
      </div>
      {moved ? (
        <Alert variant="info">
          <span>
            Moved {moved.count === 1 ? '1 line' : `${String(moved.count)} lines`} to {moved.name}.
          </span>{' '}
          <Link to="/lists/$listId" params={{ listId: moved.listId }} search={{}}>
            Open {moved.name}
          </Link>
        </Alert>
      ) : null}
      {problem?.message ? <Alert variant="warning">{problem.message}</Alert> : null}
      {problem?.error ? <ErrorState error={problem.error} /> : null}
      {list.lineCount === 0 ? (
        <EmptyState
          icon={<ListChecks />}
          title="This list is empty"
          action={
            <Link to="/quick-order" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Add products with quick order
            </Link>
          }
        >
          Paste SKUs and quantities in quick order, then add them to this list.
        </EmptyState>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Lines</CardTitle>
            <span className="flex-1" />
            {available.length < list.lines.nodes.length ? (
              <span className="text-meta text-muted-foreground">
                Unavailable lines are left out at checkout.
              </span>
            ) : null}
          </CardHeader>
          <CardContent>
            {anySelected ? (
              <div className="mb-3 flex flex-wrap items-end gap-3 rounded-md border bg-muted p-3">
                {targets ? (
                  <>
                    <ListPicker
                      label="Move to"
                      lists={targets}
                      target={target}
                      onTarget={setTarget}
                      newName={newName}
                      onNewName={setNewName}
                    />
                    <Button
                      disabled={busy || (target === NEW_LIST && newName.trim() === '')}
                      onClick={() => void move()}
                    >
                      Move {chosen.length === 1 ? '1 line' : `${String(chosen.length)} lines`}
                    </Button>
                  </>
                ) : (
                  <span className="text-meta text-muted-foreground">Loading your lists…</span>
                )}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSelected(new Set());
                  }}
                >
                  Clear selection
                </Button>
              </div>
            ) : null}
            <Table>
              <TableHeader>
                <tr>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label="Select all lines"
                      checked={allChosen}
                      onChange={(event) => {
                        setSelected(
                          event.target.checked
                            ? new Set(list.lines.nodes.map((line) => line.id))
                            : new Set(),
                        );
                      }}
                    />
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Line total</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {list.lines.nodes.map((line) => (
                  <ListLine
                    key={`${line.id} ${line.quantity}`}
                    line={line}
                    busy={busy}
                    selected={selected.has(line.id)}
                    onSelect={(on) => {
                      toggle(line.id, on);
                    }}
                    onQuantity={(quantity) =>
                      void act(
                        async () =>
                          (
                            await runOperation(UpdateShoppingListLine, {
                              listId,
                              lineId: line.id,
                              quantity,
                            })
                          ).updateShoppingListLine,
                      )
                    }
                    onRemove={() =>
                      void act(
                        async () =>
                          (
                            await runOperation(RemoveShoppingListLines, {
                              listId,
                              lineIds: [line.id],
                            })
                          ).removeShoppingListLines,
                      )
                    }
                  />
                ))}
              </TableBody>
            </Table>
            <nav className="mt-3 flex flex-wrap items-center gap-3" aria-label="Pages">
              <span className="flex-1" />
              {after !== undefined ? (
                <Link
                  to="/lists/$listId"
                  params={{ listId }}
                  search={{}}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  First lines
                </Link>
              ) : null}
              {list.lines.nextAfter !== null ? (
                <Link
                  to="/lists/$listId"
                  params={{ listId }}
                  search={{ after: list.lines.nextAfter }}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  More lines
                </Link>
              ) : null}
            </nav>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ListLine({
  line,
  busy,
  selected,
  onSelect,
  onQuantity,
  onRemove,
}: {
  line: Line;
  busy: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onQuantity: (quantity: string) => void;
  onRemove: () => void;
}) {
  const { shell } = authedRoute.useRouteContext();
  const { locale } = shell.website;
  const [text, setText] = useState(line.quantity);
  const product = line.product;
  const unit = product?.units.find((u) => u.code === line.unitCode);
  const check = unit ? checkQuantity(text, unit) : undefined;
  const changed = check?.ok === true && check.quantity !== line.quantity;
  const id = `qty-${line.id}`;

  return (
    <TableRow>
      <TableCell className="w-8">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          aria-label={`Select ${product?.name ?? 'unavailable line'}`}
          checked={selected}
          onChange={(event) => {
            onSelect(event.target.checked);
          }}
        />
      </TableCell>
      <TableCell className="min-w-[200px] whitespace-normal">
        {product ? (
          <>
            <Link
              to="/p/$sku"
              params={{ sku: product.sku }}
              className="font-[550] text-foreground hover:underline"
            >
              {product.name}
            </Link>
            <div className="font-mono text-xs text-muted-foreground">{product.sku}</div>
          </>
        ) : (
          <>
            <div className="font-[550] text-muted-foreground">Unavailable</div>
            <div className="text-xs text-muted-foreground">
              You can no longer order this product.
            </div>
          </>
        )}
        {line.note ? <div className="mt-0.5 text-xs text-muted-foreground">{line.note}</div> : null}
      </TableCell>
      <TableCell>
        {unit ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (check?.ok && changed) onQuantity(check.quantity);
            }}
          >
            <label className="sr-only" htmlFor={id}>
              Quantity of {product?.name ?? 'this line'}
            </label>
            <Input
              id={id}
              inputSize="sm"
              className="num w-[90px]"
              inputMode={unit.precision === 0 ? 'numeric' : 'decimal'}
              value={text}
              aria-invalid={check?.ok === false}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
            <span className="text-meta text-muted-foreground">{unit.name}</span>
            {changed ? (
              <Button type="submit" size="sm" variant="outline" disabled={busy}>
                Save
              </Button>
            ) : null}
          </form>
        ) : (
          <span className="tabular-nums">
            {line.quantity} {line.unitCode}
          </span>
        )}
        {check?.ok === false ? (
          <div role="alert" className="mt-1 text-xs text-destructive-text">
            {check.message}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {line.price ? formatPrice(line.price.unitPrice, locale) : product ? 'No price' : ''}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {line.price
          ? formatPrice(
              {
                amount: lineTotal(line.price.unitPrice, line.quantity),
                currency: line.price.unitPrice.currency,
              },
              locale,
            )
          : ''}
      </TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </TableCell>
    </TableRow>
  );
}
