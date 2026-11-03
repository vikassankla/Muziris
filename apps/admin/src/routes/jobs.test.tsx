import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderApp, signedIn } from '../test/mock-api.js';

const JOB = {
  id: '7c1e0a11-0000-4000-8000-000000000081',
  name: 'visibility.build',
  state: 'created',
  retryCount: 0,
  createdAt: '2026-11-03T06:00:00.000Z',
  startAfter: '2026-11-03T06:00:15.000Z',
  completedAt: null,
};
const FAILED = {
  ...JOB,
  id: '7c1e0a11-0000-4000-8000-000000000082',
  name: 'notifications.send',
  state: 'failed',
  retryCount: 3,
  completedAt: '2026-11-03T06:10:00.000Z',
};

describe('jobs', () => {
  it('lists waiting and failed jobs under System', async () => {
    mockApi({
      ...signedIn(['job.view']),
      'GET /jobs': () => json({ queued: [JOB], failed: [FAILED] }),
    });
    renderApp('/jobs');
    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Jobs' })).toBeTruthy();
    expect(screen.getByText('Visibility build')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    const failedRow = screen.getByText('Send emails').closest('tr');
    expect(failedRow).toBeTruthy();
    expect(within(failedRow!).getByText('Failed')).toBeTruthy();
    expect(within(failedRow!).getByText('3 retries')).toBeTruthy();
  });

  it('says when nothing waits or failed', async () => {
    mockApi({
      ...signedIn(['job.view']),
      'GET /jobs': () => json({ queued: [], failed: [] }),
    });
    renderApp('/jobs');
    expect(await screen.findByText('Nothing waiting')).toBeTruthy();
    expect(screen.getByText('No failed jobs')).toBeTruthy();
  });
});
