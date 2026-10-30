import type { ShellData } from './session.js';

export type Category = ShellData['categories'][number];

function byPosition(a: Category, b: Category): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/**
 * The buyer's visible categories as a tree. A category whose parent the buyer cannot see is
 * shown at the top (the API gives it a null parentId).
 */
export class CategoryTree {
  readonly #byId: ReadonlyMap<string, Category>;
  readonly #children: ReadonlyMap<string | null, readonly Category[]>;

  constructor(categories: readonly Category[]) {
    this.#byId = new Map(categories.map((c) => [c.id, c]));
    const children = new Map<string | null, Category[]>();
    for (const category of categories) {
      const parent =
        category.parentId !== null && this.#byId.has(category.parentId) ? category.parentId : null;
      const list = children.get(parent) ?? [];
      list.push(category);
      children.set(parent, list);
    }
    for (const list of children.values()) list.sort(byPosition);
    this.#children = children;
  }

  get(id: string): Category | undefined {
    return this.#byId.get(id);
  }

  /** The categories directly under `id`, or the top level for null. */
  children(id: string | null): readonly Category[] {
    return this.#children.get(id) ?? [];
  }

  /** The category and the ones above it, top first. */
  path(id: string): readonly Category[] {
    const path: Category[] = [];
    let current = this.#byId.get(id);
    while (current && path.length < 50) {
      path.unshift(current);
      current = current.parentId === null ? undefined : this.#byId.get(current.parentId);
    }
    return path;
  }
}
