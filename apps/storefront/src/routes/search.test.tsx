import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { data, mockApi, ROW, signedIn, renderApp, type MockRequest } from '../test/mock-api.js';

const hit = (match: string, sku: string) => ({ match, product: { ...ROW, id: sku, sku } });

function results(request: MockRequest) {
  const query = request.variables?.['query'];
  if (query === 'hexbolt') {
    return data({ search: { nodes: [hit('CLOSE', 'HB-M8-40')], nextOffset: null } });
  }
  if (query === 'zzz') return data({ search: { nodes: [], nextOffset: null } });
  return data({
    search: {
      nodes: [hit('SKU_EXACT', 'HB-M8'), hit('SKU_PREFIX', 'HB-M8-40'), hit('TEXT', 'NUT-M8')],
      nextOffset: request.variables?.['offset'] === 0 ? 20 : null,
    },
  });
}

describe('search', () => {
  it('searches from the header and labels each match', async () => {
    const requests = mockApi({
      ...signedIn(),
      'GraphQL Products': () => data({ products: { nodes: [], nextAfter: null } }),
      'GraphQL Search': results,
    });
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), ' HB-M8 {Enter}');
    expect(await screen.findByRole('heading', { name: 'Results for “HB-M8”' })).toBeTruthy();
    expect(router.state.location.search).toEqual({ q: 'HB-M8' });
    const rows = within(screen.getByRole('table', { name: 'Products' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell').at(-2)?.textContent)).toEqual([
      'SKU',
      'SKU starts with',
      'Name or details',
    ]);
    expect(requests.at(-1)?.variables).toEqual({ query: 'HB-M8', first: 20, offset: 0 });
    // The search box keeps the text on the results page.
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('HB-M8');

    await user.click(screen.getByRole('link', { name: 'Next' }));
    await screen.findByRole('link', { name: 'Previous' });
    expect(router.state.location.search).toEqual({ q: 'HB-M8', offset: 20 });
    expect(requests.at(-1)?.variables).toEqual({ query: 'HB-M8', first: 20, offset: 20 });
  });

  it('says when only close spellings matched', async () => {
    mockApi({ ...signedIn(), 'GraphQL Search': results });
    renderApp('/search?q=hexbolt');
    expect(
      await screen.findByText('No exact match for “hexbolt”. Showing close spellings.'),
    ).toBeTruthy();
  });

  it('says when nothing matched, and asks for text before searching', async () => {
    const requests = mockApi({ ...signedIn(), 'GraphQL Search': results });
    const { router } = renderApp('/search?q=zzz');
    expect(await screen.findByRole('heading', { name: 'No results for “zzz”' })).toBeTruthy();
    await router.navigate({ to: '/search', search: { q: '' } });
    expect(await screen.findByRole('heading', { name: 'Search the catalogue' })).toBeTruthy();
    expect(requests.filter((r) => r.operationName === 'Search')).toHaveLength(1);
  });
});
