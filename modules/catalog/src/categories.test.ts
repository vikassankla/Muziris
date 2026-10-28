import { describe, expect, it } from 'vitest';
import { buildCategoryTree, newCategorySchema, type Category, type CategoryNode } from './index.js';

const at = new Date('2026-11-04T10:00:00.000Z');

function category(id: string, name: string, parentId: string | null, position = 0): Category {
  return {
    id,
    code: name.toLowerCase().replace(/\W+/g, '_'),
    name,
    parentId,
    position,
    createdAt: at,
    updatedAt: at,
  };
}

function names(nodes: CategoryNode[]): unknown[] {
  return nodes.map((n) => (n.children.length > 0 ? [n.name, names(n.children)] : n.name));
}

describe('buildCategoryTree', () => {
  it('nests categories under their parents, siblings by position and then name', () => {
    const tree = buildCategoryTree([
      category('c1', 'Safety', null, 2),
      category('c2', 'Fasteners', null, 1),
      category('c3', 'Nuts', 'c2'),
      category('c4', 'Bolts', 'c2'),
      category('c5', 'Hex bolts', 'c4', 1),
      category('c6', 'Carriage bolts', 'c4', 0),
      category('c7', 'Abrasives', null, 2),
    ]);
    expect(names(tree)).toEqual([
      ['Fasteners', [['Bolts', ['Carriage bolts', 'Hex bolts']], 'Nuts']],
      'Abrasives',
      'Safety',
    ]);
  });

  it('makes a category whose parent is not in the list a root, so a subtree stands alone', () => {
    const tree = buildCategoryTree([
      category('c4', 'Bolts', 'c2'),
      category('c5', 'Hex bolts', 'c4'),
    ]);
    expect(names(tree)).toEqual([['Bolts', ['Hex bolts']]]);
  });

  it('returns nothing for no categories', () => {
    expect(buildCategoryTree([])).toEqual([]);
  });
});

describe('new category', () => {
  it.each([
    [{ code: 'fasteners', name: 'Fasteners' }, true],
    [{ code: 'hand_tools_2', name: ' Hand tools ' }, true],
    [{ code: 'f', name: 'F' }, false],
    [{ code: 'Fasteners', name: 'Fasteners' }, false],
    [{ code: 'hand-tools', name: 'Hand tools' }, false],
    [{ code: 'fasteners', name: '   ' }, false],
    [{ code: 'fasteners', name: 'Fasteners', position: -1 }, false],
    [{ code: 'fasteners', name: 'Fasteners', parentId: 'not-a-uuid' }, false],
  ])('%j is valid: %s', (input, valid) => {
    expect(newCategorySchema.safeParse(input).success).toBe(valid);
  });
});
