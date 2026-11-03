import { createRoute } from '@tanstack/react-router';
import { Timer } from 'lucide-react';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { EmptyState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { listJobs, type Job } from '../lib/endpoints.js';
import { formatDateTime } from '../lib/format.js';
import { useRefreshWhileBuilding } from '../lib/jobs.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

// The job runner's queue (ADR 0025), read only: what waits or runs, and what failed after its
// retries. Jobs carry no data, so a job is its name and its times.

/** What each job does, in words. */
const JOB_LABELS: Record<Job['name'], string> = {
  'pricing.build': 'Price build',
  'visibility.build': 'Visibility build',
  'search.build': 'Search index build',
  'notifications.send': 'Send emails',
  'sessions.cleanup': 'Clean up sessions',
};

const STATE_LABELS: Record<Job['state'], string> = {
  created: 'Waiting',
  retry: 'Retrying',
  active: 'Running',
  failed: 'Failed',
};
const STATE_TONES: Record<Job['state'], 'info' | 'warning' | 'success' | 'destructive'> = {
  created: 'info',
  retry: 'warning',
  active: 'success',
  failed: 'destructive',
};

export const jobsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/jobs',
  loader: ({ abortController }) => listJobs(abortController.signal),
  component: JobsPage,
});

function JobTable({ jobs, failed }: { jobs: Job[]; failed: boolean }) {
  const website = useWebsite();
  return (
    <Table>
      <TableHeader>
        <tr>
          <TableHead>Job</TableHead>
          <TableHead aria-sort="descending">Queued</TableHead>
          <TableHead>{failed ? 'Last tried' : 'Starts'}</TableHead>
          <TableHead>Status</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell>
              <div className="font-[550]">{JOB_LABELS[job.name]}</div>
              <div className="font-mono text-xs text-muted-foreground">{job.name}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDateTime(job.createdAt, website)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDateTime(
                failed ? (job.completedAt ?? job.startAfter) : job.startAfter,
                website,
              )}
            </TableCell>
            <TableCell>
              <Badge variant={STATE_TONES[job.state]}>{STATE_LABELS[job.state]}</Badge>
              {job.retryCount > 0 ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {job.retryCount} {job.retryCount === 1 ? 'retry' : 'retries'}
                </div>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function JobsPage() {
  const { queued, failed } = jobsRoute.useLoaderData();
  useRefreshWhileBuilding(queued.length > 0 ? 'queued' : 'idle');

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Jobs' }]} />
      <PageHeader
        title="Jobs"
        description="Builds, emails and clean-up that run in the background. A job is tried four times before it fails; the logs have the reason."
      />
      <Card>
        <CardHeader>
          <CardTitle>Waiting and running</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {queued.length === 0 ? (
            <EmptyState
              icon={Timer}
              title="Nothing waiting"
              description="Price, visibility and search builds appear here a few seconds after a change."
            />
          ) : (
            <JobTable jobs={queued} failed={false} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Failed</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {failed.length === 0 ? (
            <EmptyState
              icon={Timer}
              title="No failed jobs"
              description="A job that fails after its retries stays here for a week."
            />
          ) : (
            <JobTable jobs={failed} failed />
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
