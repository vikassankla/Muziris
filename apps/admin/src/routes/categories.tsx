import { createRoute, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, FolderTree, Plus, Search } from 'lucide-react';
import { useState, type KeyboardEvent, type SubmitEvent } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { flattenCategories, subtreeIds, type FlatCategory } from '../lib/categories.js';
import {
  createCategory,
  deleteCategory,
  listCategories,
  setCategoryParent,
  updateCategory,
  type CategoryNode,
} from '../lib/endpoints.js';
import { CODE_HINT, CODE_PATTERN, fieldErrors } from '../lib/form.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { authedRoute } from './authed.js';
import { codeFromName } from './customer-groups.js';

interface CategoriesSearch extends ListSearch {
  selected?: string;
}

const TOP = '__top';

export const categoriesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/categories',
  validateSearch: (search: Record<string, unknown>): CategoriesSearch => {
    const selected = search['selected'];
    return {
      ...listSearch(search),
      ...(typeof selected === 'string' && selected ? { selected } : {}),
    };
  },
  loader: ({ abortController }) => listCategories(abortController.signal),
  component: CategoriesPage,
});

function siblingsOf(
  tree: readonly CategoryNode[],
  flat: readonly FlatCategory[],
  node: CategoryNode,
): CategoryNode[] {
  if (node.parentId === null) return [...tree];
  return flat.find((c) => c.node.id === node.parentId)?.node.children ?? [];
}

function ParentSelect({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: readonly FlatCategory[];
}) {
  return (
    <Select
      value={value ?? TOP}
      onValueChange={(next) => {
        onChange(next === TOP ? null : next);
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TOP}>None (top level)</SelectItem>
        {options.map((c) => (
          <SelectItem key={c.node.id} value={c.node.id}>
            {c.path}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewCategoryDialog({
  open,
  onOpenChange,
  categories,
  parentId: initialParent,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: readonly FlatCategory[];
  parentId: string | null;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [parentId, setParentId] = useState<string | null>(initialParent);
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const shownCode = codeEdited ? code : codeFromName(name);
  const codeError =
    problem?.code === 'category_code_taken'
      ? 'A category with this code already exists.'
      : shownCode !== '' && !CODE_PATTERN.test(shownCode)
        ? 'Use 2 to 63 lowercase letters, digits or underscores, starting with a letter.'
        : errors['code'];

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const siblings =
      parentId === null
        ? categories.filter((c) => c.level === 1)
        : categories.filter((c) => c.node.parentId === parentId);
    const position = siblings.reduce((max, c) => Math.max(max, c.node.position + 1), 0);
    const category = await submit(
      () => createCategory({ code: shownCode, name, parentId, position }),
      {
        title: 'Category created',
        description: name,
      },
    );
    if (category) {
      setName('');
      setCode('');
      setCodeEdited(false);
      onCreated(category.id);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setParentId(initialParent);
        else setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>
            It goes last among its siblings; move it after saving.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem &&
          problem.code !== 'validation_failed' &&
          problem.code !== 'category_code_taken' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field label="Name" error={errors['name']}>
            {(props) => (
              <Input
                {...props}
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Code" hint={`${CODE_HINT} Used in imports and the API.`} error={codeError}>
            {(props) => (
              <Input
                {...props}
                required
                className="font-mono"
                maxLength={63}
                value={shownCode}
                onChange={(e) => {
                  setCodeEdited(true);
                  setCode(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Parent category">
            {({ id }) => (
              <ParentSelect id={id} value={parentId} onChange={setParentId} options={categories} />
            )}
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Create category
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CategoryEditor({
  flat,
  category,
  manage,
  onDeleted,
}: {
  flat: readonly FlatCategory[];
  category: FlatCategory;
  manage: boolean;
  onDeleted: () => void;
}) {
  const { node } = category;
  const [name, setName] = useState(node.name);
  const [parentId, setParentId] = useState<string | null>(node.parentId);
  const [confirm, setConfirm] = useState(false);
  const { pending, problem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const blocked = subtreeIds(node);
  const parents = flat.filter((c) => !blocked.has(c.node.id));
  const dirty = name !== node.name || parentId !== node.parentId;

  async function save() {
    await submit(
      async () => {
        if (name !== node.name) await updateCategory(node.id, { name });
        if (parentId !== node.parentId) await setCategoryParent(node.id, parentId);
        return true;
      },
      { title: 'Category saved', description: name },
    );
  }

  return (
    <Card className="min-w-0 flex-[1_1_360px]" aria-labelledby="category-editor">
      <CardHeader>
        <CardTitle id="category-editor">{node.name}</CardTitle>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{category.path}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {problem && problem.code !== 'validation_failed' ? (
          <ProblemAlert problem={problem} />
        ) : null}
        <Field label="Name" error={errors['name']}>
          {(props) => (
            <Input
              {...props}
              maxLength={200}
              disabled={!manage}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Code" hint="Used in imports and the API. Cannot be changed.">
          {(props) => <Input {...props} className="font-mono" readOnly value={node.code} />}
        </Field>
        <Field label="Parent category">
          {({ id }) =>
            manage ? (
              <ParentSelect id={id} value={parentId} onChange={setParentId} options={parents} />
            ) : (
              <Input
                id={id}
                readOnly
                value={flat.find((c) => c.node.id === node.parentId)?.path ?? 'None (top level)'}
              />
            )
          }
        </Field>
        <dl className="m-0 grid grid-cols-[140px_1fr] gap-x-4 gap-y-2.5">
          <dt className="text-muted-foreground">Subcategories</dt>
          <dd className="m-0">
            {node.children.length === 0 ? 'None' : node.children.map((c) => c.name).join(', ')}
          </dd>
        </dl>
      </CardContent>
      {manage ? (
        <CardFooter className="justify-between">
          <Button
            variant="ghost-destructive"
            onClick={() => {
              setConfirm(true);
            }}
          >
            Delete category…
          </Button>
          <span className="flex gap-2">
            <Button
              variant="outline"
              disabled={!dirty}
              onClick={() => {
                setName(node.name);
                setParentId(node.parentId);
              }}
            >
              Cancel
            </Button>
            <Button disabled={!dirty || pending} onClick={() => void save()}>
              Save
            </Button>
          </span>
        </CardFooter>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete category “${node.name}”?`}
        description="Only an empty category can be deleted: move its subcategories and products first. This cannot be undone."
        confirmLabel="Delete category"
        onConfirm={async () => {
          await deleteCategory(node.id);
          onDeleted();
        }}
      />
    </Card>
  );
}

function CategoriesPage() {
  const tree = categoriesRoute.useLoaderData();
  const search = categoriesRoute.useSearch();
  const navigate = useNavigate();
  const manage = can(useSession(), 'product.manage');
  const [filter, setFilter] = useState('');
  const move = useSubmit();
  const flat = flattenCategories(tree);
  const selected = flat.find((c) => c.node.id === search.selected) ?? flat[0];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? flat.filter((c) => c.path.toLowerCase().includes(needle) || c.node.code.includes(needle))
    : flat;

  const select = (id: string) => {
    void navigate({ to: '.', search: { selected: id }, replace: true });
  };
  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew<CategoriesSearch>(open) });
  };

  /** Moves a category one place up or down among its siblings, renumbering them. */
  async function reorder(node: CategoryNode, direction: -1 | 1) {
    const siblings = siblingsOf(tree, flat, node);
    const index = siblings.findIndex((s) => s.id === node.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= siblings.length) return;
    const order = [...siblings];
    const [moved] = order.splice(index, 1);
    if (!moved) return;
    order.splice(target, 0, moved);
    await move.submit(async () => {
      for (const [position, sibling] of order.entries()) {
        if (sibling.position !== position * 10)
          await updateCategory(sibling.id, { position: position * 10 });
      }
      return true;
    });
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (!selected) return;
    const index = shown.findIndex((c) => c.node.id === selected.node.id);
    if (event.altKey && manage && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      void reorder(selected.node, event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = shown[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) select(next.node.id);
    }
  }

  const newButton = manage ? (
    <Button
      onClick={() => {
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New category
    </Button>
  ) : null;

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Catalog' }, { label: 'Categories' }]} />
      <PageHeader
        title="Categories"
        description={
          manage
            ? 'Select a category to rename it or move it under another parent. Reorder with the arrows, or Alt + arrow keys.'
            : 'The category tree in display order.'
        }
        actions={newButton}
      />
      {flat.length === 0 ? (
        <EmptyState
          icon={FolderTree}
          title="No categories yet"
          description="Categories group products for buyers to browse, for example Bearings › Ball bearings."
          action={newButton ?? undefined}
        />
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <Card className="min-w-0 flex-[1_1_420px]">
            <CardHeader>
              <div className="relative flex flex-1 items-center">
                <Search
                  className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  inputSize="sm"
                  className="pl-8"
                  aria-label="Filter categories"
                  placeholder="Filter categories"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                  }}
                />
              </div>
            </CardHeader>
            {move.problem ? (
              <div className="px-4 pt-3">
                <ProblemAlert problem={move.problem} />
              </div>
            ) : null}
            <ul
              role="tree"
              aria-label="Categories"
              tabIndex={0}
              onKeyDown={onTreeKeyDown}
              aria-activedescendant={selected ? `cat-${selected.node.id}` : undefined}
              className="m-0 list-none p-2 focus-visible:outline-offset-[-2px]"
            >
              {shown.map((c) => {
                const isSelected = c.node.id === selected?.node.id;
                const siblings = siblingsOf(tree, flat, c.node);
                const index = siblings.findIndex((s) => s.id === c.node.id);
                return (
                  <li
                    key={c.node.id}
                    id={`cat-${c.node.id}`}
                    role="treeitem"
                    aria-level={c.level}
                    aria-selected={isSelected}
                    aria-expanded={c.node.children.length > 0 ? true : undefined}
                    className={`group flex h-9 items-center gap-2 rounded-md pr-2 ${isSelected ? 'bg-accent' : 'hover:bg-muted'}`}
                    style={{ paddingLeft: `${String(8 + (c.level - 1) * 24)}px` }}
                    onClick={() => {
                      select(c.node.id);
                    }}
                  >
                    <span
                      className="w-3.5 text-center text-[11px] text-muted-foreground"
                      aria-hidden="true"
                    >
                      {c.node.children.length > 0 ? '▾' : ''}
                    </span>
                    <span className={c.level === 1 || isSelected ? 'font-semibold' : ''}>
                      {c.node.name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{c.node.code}</span>
                    <span className="flex-1" />
                    {manage && !needle ? (
                      <span
                        className={`flex gap-0.5 ${isSelected ? '' : 'opacity-0 group-hover:opacity-100'}`}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          tabIndex={-1}
                          aria-label={`Move ${c.node.name} up`}
                          disabled={index <= 0 || move.pending}
                          onClick={(event) => {
                            event.stopPropagation();
                            void reorder(c.node, -1);
                          }}
                        >
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          tabIndex={-1}
                          aria-label={`Move ${c.node.name} down`}
                          disabled={index >= siblings.length - 1 || move.pending}
                          onClick={(event) => {
                            event.stopPropagation();
                            void reorder(c.node, 1);
                          }}
                        >
                          <ArrowDown aria-hidden="true" />
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
          {selected ? (
            <CategoryEditor
              key={`${selected.node.id}-${selected.node.name}-${selected.node.parentId ?? ''}`}
              flat={flat}
              category={selected}
              manage={manage}
              onDeleted={() => {
                void navigate({ to: '.', search: {} });
              }}
            />
          ) : null}
        </div>
      )}
      {manage ? (
        <NewCategoryDialog
          open={search.new === true}
          onOpenChange={setNew}
          categories={flat}
          parentId={selected?.node.id ?? null}
          onCreated={(id) => {
            void navigate({ to: '.', search: { selected: id } });
          }}
        />
      ) : null}
    </Page>
  );
}
