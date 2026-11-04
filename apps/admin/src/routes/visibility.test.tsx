import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, problem, renderApp, signedIn, WEBSITES } from '../test/mock-api.js';

const [INDIA] = WEBSITES;
const CUSTOMER = {
  id: '7c1e0a11-0000-4000-8000-0000000000c1',
  name: 'Periyar Spices',
  parentId: null,
  groupId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const GROUP = {
  id: '7c1e0a11-0000-4000-8000-0000000000f1',
  code: 'key-accounts',
  name: 'Key accounts',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const CATEGORY = {
  id: '7c1e0a11-0000-4000-8000-0000000000a1',
  code: 'power-transmission',
  name: 'Power transmission',
  parentId: null,
  position: 0,
  children: [],
};
const RULE = {
  id: '7c1e0a11-0000-4000-8000-0000000000d1',
  websiteId: INDIA.id,
  subject: 'category',
  subjectId: CATEGORY.id,
  subjectSku: null,
  subjectName: 'Power transmission',
  target: 'customer_group',
  targetId: GROUP.id,
  targetName: 'Key accounts',
  visibility: 'hidden',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const PRODUCT_RULE = {
  ...RULE,
  id: '7c1e0a11-0000-4000-8000-0000000000d2',
  subject: 'product',
  subjectId: '7c1e0a11-0000-4000-8000-0000000000b1',
  subjectSku: 'BRG-6204',
  subjectName: 'Ball bearing 6204',
  target: 'website',
  targetId: INDIA.id,
  targetName: 'India',
  visibility: 'visible',
};
const empty = (key: string) => () => json({ [key]: [], nextAfter: null });
const BUILD = {
  build: {
    pendingChanges: 2,
    catalogChangedSinceBuild: false,
    lastBuild: null,
    job: 'idle',
  },
};

function visibilityApi(permissions: string[], rules: unknown[] = [RULE, PRODUCT_RULE]) {
  return {
    ...signedIn(permissions),
    'GET /visibility/rules': () => json({ rules, nextAfter: null }),
    'GET /visibility/build': () => json(BUILD),
    'GET /customers': () => json({ customers: [CUSTOMER], nextAfter: null }),
    'GET /customers/groups': () => json({ customerGroups: [GROUP], nextAfter: null }),
    'GET /catalog/categories': () => json({ categories: [CATEGORY] }),
  };
}

describe('visibility', () => {
  it('lists rules by name for the website in the top bar, and searches them', async () => {
    const requests = mockApi(visibilityApi(['visibility.view']));
    renderApp('/visibility');
    expect(await screen.findByText('Power transmission')).toBeTruthy();
    expect(screen.getByText('BRG-6204 · Ball bearing 6204')).toBeTruthy();
    expect(screen.getByText('Everyone on India')).toBeTruthy();
    expect(screen.getByText('Key accounts')).toBeTruthy();
    expect(screen.getByText('Buyers do not see 2 visibility rule changes yet')).toBeTruthy();
    // Read-only without visibility.manage.
    expect(screen.queryByRole('button', { name: 'New rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete the rule/ })).toBeNull();
    expect(requests.find((r) => r.path === '/visibility/rules')?.query.get('websiteId')).toBe(
      INDIA.id,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search rules'), 'key acc');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(
        requests
          .filter((r) => r.path === '/visibility/rules')
          .at(-1)
          ?.query.get('q'),
      ).toBe('key acc');
    });
  });

  it('hides a category from a customer group, and offers to change a rule already there', async () => {
    const requests = mockApi({
      ...visibilityApi(['visibility.view', 'visibility.manage']),
      'POST /visibility/rules': () =>
        problem(
          409,
          'rule_taken',
          'This product or category already has a rule for this target on this website',
        ),
      [`PATCH /visibility/rules/${RULE.id}`]: () => json({ rule: RULE }),
    });
    renderApp('/visibility?new=true');
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'New visibility rule' });
    await user.click(within(sheet).getByRole('combobox', { name: 'Rule on' }));
    await user.click(
      await screen.findByRole('option', { name: 'A category and everything in it' }),
    );
    await user.click(within(sheet).getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'Power transmission' }));
    await user.click(within(sheet).getByRole('combobox', { name: 'Customer group' }));
    await user.click(await screen.findByRole('option', { name: 'Key accounts' }));
    await user.click(within(sheet).getByRole('combobox', { name: 'Visibility' }));
    await user.click(await screen.findByRole('option', { name: 'Visible' }));
    await user.click(within(sheet).getByRole('button', { name: 'Create rule' }));

    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
        websiteId: INDIA.id,
        subject: 'category',
        subjectId: CATEGORY.id,
        target: 'customer_group',
        targetId: GROUP.id,
        visibility: 'visible',
      });
    });
    expect(
      await within(sheet).findByText('This already has a rule for Key accounts: Hidden.'),
    ).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Change that rule to Visible' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ visibility: 'visible' });
    });
  });

  it('switches a rule between hidden and visible, and deletes one after confirming', async () => {
    const requests = mockApi({
      ...visibilityApi(['visibility.view', 'visibility.manage'], [RULE]),
      [`PATCH /visibility/rules/${RULE.id}`]: () => json({ rule: RULE }),
      [`DELETE /visibility/rules/${RULE.id}`]: () => new Response(null, { status: 204 }),
    });
    renderApp('/visibility');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Make visible: Power transmission for Key accounts',
      }),
    );
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ visibility: 'visible' });
    });
    await user.click(
      screen.getByRole('button', {
        name: 'Delete the rule on Power transmission for Key accounts',
      }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this rule?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'DELETE')).toBe(true);
    });
  });

  it('checks what a buyer sees, and says when the change waits for a build', async () => {
    const requests = mockApi({
      ...visibilityApi(['visibility.view']),
      'GET /visibility/preview': () =>
        json({
          preview: {
            subject: 'category',
            subjectId: CATEGORY.id,
            categoryPath: [CATEGORY.id],
            visible: false,
            reason: 'rule',
            rule: RULE,
            categoryDistance: 0,
            built: { visible: true, context: 'customer_group', needsRebuild: false },
            pendingChanges: 1,
          },
        }),
    });
    renderApp('/visibility');
    const user = userEvent.setup();
    await screen.findByText('Power transmission');
    await user.click(screen.getByRole('button', { name: 'Check a buyer’s view' }));
    const sheet = await screen.findByRole('dialog', { name: 'Check a buyer’s view' });
    await user.click(within(sheet).getByRole('combobox', { name: 'Customer' }));
    await user.click(await screen.findByRole('option', { name: 'Periyar Spices' }));
    await user.click(within(sheet).getByRole('combobox', { name: 'Rule on' }));
    await user.click(
      await screen.findByRole('option', { name: 'A category and everything in it' }),
    );
    await user.click(within(sheet).getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'Power transmission' }));
    await user.click(within(sheet).getByRole('button', { name: 'Check' }));

    expect(
      await within(sheet).findByText('Hidden by the rule on Power transmission for Key accounts.'),
    ).toBeTruthy();
    expect(within(sheet).getByText('The change waits for a visibility build.')).toBeTruthy();
    const query = requests.find((r) => r.path === '/visibility/preview')?.query;
    expect(query?.get('customerId')).toBe(CUSTOMER.id);
    expect(query?.get('categoryId')).toBe(CATEGORY.id);
    expect(query?.get('websiteId')).toBe(INDIA.id);
  });

  it('shows the rules for a customer on its page, linking to the screen filtered to it', async () => {
    const requests = mockApi({
      ...signedIn(['customer.view', 'visibility.view']),
      [`GET /customers/${CUSTOMER.id}`]: () => json({ customer: CUSTOMER }),
      [`GET /customers/${CUSTOMER.id}/subsidiaries`]: empty('customers'),
      [`GET /customers/${CUSTOMER.id}/buyer-users`]: empty('buyerUsers'),
      [`GET /customers/${CUSTOMER.id}/invitations`]: empty('invitations'),
      [`GET /customers/${CUSTOMER.id}/addresses`]: empty('addresses'),
      'GET /customers': () => json({ customers: [CUSTOMER], nextAfter: null }),
      'GET /visibility/rules': () =>
        json({
          rules: [{ ...PRODUCT_RULE, target: 'customer', targetId: CUSTOMER.id }],
          nextAfter: null,
        }),
    });
    renderApp(`/customers/${CUSTOMER.id}`);
    expect(await screen.findByText('BRG-6204 · Ball bearing 6204')).toBeTruthy();
    expect(requests.find((r) => r.path === '/visibility/rules')?.query.get('targetId')).toBe(
      CUSTOMER.id,
    );
    const link = screen.getByRole('link', { name: 'Open in Visibility' });
    expect(link.getAttribute('href')).toContain(`targetId=${CUSTOMER.id}`);
  });
});
