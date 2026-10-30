import { describe, expect, it } from 'vitest';
import { createLoader } from './loader.js';

describe('createLoader', () => {
  it('reads keys asked for in the same tick in one batch, once each', async () => {
    const batches: string[][] = [];
    const loader = createLoader<string, string | null>(
      (keys) => {
        batches.push([...keys]);
        return Promise.resolve(
          new Map(keys.filter((k) => k !== 'missing').map((k) => [k, k.toUpperCase()])),
        );
      },
      (k) => k,
      null,
    );
    const results = await Promise.all([
      loader.load('a'),
      loader.load('b'),
      loader.load('a'),
      Promise.resolve().then(() => loader.load('c')),
      loader.load('missing'),
    ]);
    expect(results).toEqual(['A', 'B', 'A', 'C', null]);
    expect(batches).toEqual([['a', 'b', 'missing', 'c']]);
    expect(await loader.load('b')).toBe('B');
    expect(batches).toHaveLength(1);
  });

  it('uses primed values without reading them', async () => {
    let calls = 0;
    const loader = createLoader<string, number>(
      (keys) => {
        calls += 1;
        return Promise.resolve(new Map(keys.map((k) => [k, 1])));
      },
      (k) => k,
      0,
    );
    loader.prime('x', 42);
    expect(await loader.load('x')).toBe(42);
    expect(calls).toBe(0);
  });

  it('rejects every key of a batch that fails', async () => {
    const loader = createLoader<string, number>(
      () => Promise.reject(new Error('down')),
      (k) => k,
      0,
    );
    await expect(Promise.all([loader.load('a'), loader.load('b')])).rejects.toThrow('down');
  });
});
