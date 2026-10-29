import type { Database } from '@muziris/db';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { categories } from './db/schema.js';
import {
  CatalogError,
  isForeignKeyViolation,
  isRestrictViolation,
  isUniqueViolation,
} from './errors.js';

export interface Category {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A category with its subcategories, in display order. */
export interface CategoryNode extends Category {
  children: CategoryNode[];
}

const idSchema = z.uuid();

export const newCategorySchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, 'Use 2 to 63 lowercase letters, digits or _'),
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().default(null),
  position: z.int().min(0).max(1_000_000).default(0),
});

export type NewCategory = z.input<typeof newCategorySchema>;

export const categoryChangesSchema = newCategorySchema
  .pick({ name: true, position: true })
  .partial()
  .strict();

export type CategoryChanges = z.input<typeof categoryChangesSchema>;

/**
 * Walks down the tree from the ids `start` selects. The CYCLE clause stops the walk if a cycle
 * ever got into the table, so a bad row cannot make the query run forever; the module refuses
 * moves that would create one (setCategoryParent).
 */
function walkDown(start: SQL): SQL {
  return sql`with recursive tree (id) as (
      ${start}
      union all
      select child.id from ${categories} child join tree on child.parent_id = tree.id
    ) cycle id set is_cycle using path
    select id from tree where not is_cycle`;
}

/**
 * An SQL select of the ids of every category below `categoryId`, at any depth, not including
 * it. It has no surrounding parentheses, so it can go in `in (...)`.
 */
export function descendantCategoryIds(categoryId: string): SQL {
  const id = idSchema.parse(categoryId);
  return walkDown(sql`select id from ${categories} where parent_id = ${id}`);
}

/** An SQL select of `categoryId` and every category below it. */
export function categorySubtreeIds(categoryId: string): SQL {
  const id = idSchema.parse(categoryId);
  return walkDown(sql`select id from ${categories} where id = ${id}`);
}

/**
 * An SQL select of every category's id and parent id (null at the top), as the columns
 * `category_id` and `parent_id`, without surrounding parentheses. Visibility walks it to find a
 * category's ancestors without reading catalog tables.
 */
export function categoryParents(): SQL {
  return sql`select id as category_id, parent_id from ${categories}`;
}

function siblingOrder(a: Category, b: Category): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Arranges a flat list of categories into trees, siblings ordered by position, then name. A
 * category whose parent is not in the list becomes a root, so a subtree can be arranged alone.
 */
export function buildCategoryTree(list: readonly Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const category of list) nodes.set(category.id, { ...category, children: [] });
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortAll = (level: CategoryNode[]) => {
    level.sort(siblingOrder);
    for (const node of level) sortAll(node.children);
  };
  sortAll(roots);
  return roots;
}

export async function createCategory(db: Database, input: NewCategory): Promise<Category> {
  const values = newCategorySchema.parse(input);
  try {
    const [row] = await db.insert(categories).values(values).returning();
    if (!row) throw new Error('Category insert returned no row');
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogError('category_code_taken', 'That category code is taken');
    }
    if (isForeignKeyViolation(error)) {
      throw new CatalogError('category_not_found', 'No such parent category');
    }
    throw error;
  }
}

/** Every category, flat. Pass the result to buildCategoryTree to show it as a tree. */
export async function listCategories(db: Database): Promise<Category[]> {
  return db
    .select()
    .from(categories)
    .orderBy(asc(categories.position), asc(categories.name), asc(categories.id));
}

export async function findCategory(
  db: Database,
  categoryId: string,
): Promise<Category | undefined> {
  const [row] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, idSchema.parse(categoryId)))
    .limit(1);
  return row;
}

/** Renames a category or changes its position among its siblings. */
export async function updateCategory(
  db: Database,
  categoryId: string,
  changes: CategoryChanges,
): Promise<Category> {
  const id = idSchema.parse(categoryId);
  const values = categoryChangesSchema.parse(changes);
  const [row] = await db
    .update(categories)
    .set({ ...values, updatedAt: sql`now()` })
    .where(eq(categories.id, id))
    .returning();
  if (!row) throw new CatalogError('category_not_found', 'No such category');
  return row;
}

/**
 * Moves a category under a new parent, or to the top of the tree with null. Refuses a parent
 * that is the category itself or any of its subcategories, which would form a cycle.
 *
 * Moves take one transaction-scoped advisory lock, so two concurrent moves (A under B, and B
 * under A) cannot each pass the check against the other's old state.
 */
export async function setCategoryParent(
  db: Database,
  categoryId: string,
  parentId: string | null,
): Promise<Category> {
  const id = idSchema.parse(categoryId);
  const parent = parentId === null ? null : idSchema.parse(parentId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('catalog_category.parent_id'))`);
    if (parent !== null) {
      if (parent === id) {
        throw new CatalogError('category_cycle', 'A category cannot be its own parent');
      }
      const below = await tx.execute(
        sql`select 1 from (${descendantCategoryIds(id)}) below where below.id = ${parent} limit 1`,
      );
      if (below.length > 0) {
        throw new CatalogError(
          'category_cycle',
          'A category cannot be moved under one of its own subcategories',
        );
      }
    }
    try {
      const [row] = await tx
        .update(categories)
        .set({ parentId: parent, updatedAt: sql`now()` })
        .where(eq(categories.id, id))
        .returning();
      if (!row) throw new CatalogError('category_not_found', 'No such category');
      return row;
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new CatalogError('category_not_found', 'No such parent category');
      }
      throw error;
    }
  });
}

/** Deletes a category that has no subcategories and no products. */
export async function deleteCategory(db: Database, categoryId: string): Promise<void> {
  const id = idSchema.parse(categoryId);
  try {
    const deleted = await db
      .delete(categories)
      .where(eq(categories.id, id))
      .returning({ id: categories.id });
    if (deleted.length === 0) throw new CatalogError('category_not_found', 'No such category');
  } catch (error) {
    if (isRestrictViolation(error)) {
      throw new CatalogError(
        'category_not_empty',
        'Move or delete its subcategories and products first',
      );
    }
    throw error;
  }
}
