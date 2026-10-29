import type { CategoryNode } from './endpoints.js';

export interface FlatCategory {
  node: CategoryNode;
  level: number;
  /** "Bearings › Ball bearings" */
  path: string;
}

/** The tree in display order, each category with its depth and path. */
export function flattenCategories(
  nodes: readonly CategoryNode[],
  level = 1,
  prefix = '',
): FlatCategory[] {
  return nodes.flatMap((node) => {
    const path = prefix ? `${prefix} › ${node.name}` : node.name;
    return [{ node, level, path }, ...flattenCategories(node.children, level + 1, path)];
  });
}

/** The ids of a category and everything under it: places it cannot be moved to. */
export function subtreeIds(node: CategoryNode): Set<string> {
  const ids = new Set<string>([node.id]);
  for (const child of node.children) for (const id of subtreeIds(child)) ids.add(id);
  return ids;
}
