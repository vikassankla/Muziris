import { describe, expect, it } from 'vitest';
import { CategoryTree } from './categories.js';

const tree = new CategoryTree([
  { id: 'b', name: 'Bolts', parentId: 'f', position: 2 },
  { id: 'n', name: 'Nuts', parentId: 'f', position: 1 },
  { id: 'f', name: 'Fasteners', parentId: null, position: 1 },
  { id: 'h', name: 'Hex bolts', parentId: 'b', position: 1 },
  { id: 'o', name: 'Orphan', parentId: 'hidden', position: 0 },
]);

describe('CategoryTree', () => {
  it('orders children by position', () => {
    expect(tree.children('f').map((c) => c.id)).toEqual(['n', 'b']);
  });

  it('puts a category whose parent is hidden at the top', () => {
    expect(tree.children(null).map((c) => c.id)).toEqual(['o', 'f']);
  });

  it('gives the path from the top', () => {
    expect(tree.path('h').map((c) => c.name)).toEqual(['Fasteners', 'Bolts', 'Hex bolts']);
    expect(tree.path('o').map((c) => c.id)).toEqual(['o']);
    expect(tree.path('missing')).toEqual([]);
  });
});
