import { CircleAlert, RefreshCw } from 'lucide-react';
import { buildVisibility, type VisibilityBuildState } from '../lib/endpoints.js';
import { formatCount, formatDateTime } from '../lib/format.js';
import { buildProgress, useRefreshWhileBuilding } from '../lib/jobs.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { ProblemAlert } from './problem-view.js';
import { Alert, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';

/**
 * Says when buyers do not see the catalog as it is now. Products, categories and visibility
 * rules reach buyers only after a build (ADR 0012), which their changes queue (ADR 0025): the
 * banner shows it queued, then running, then goes. With no build waiting, a visibility manager
 * gets "Build visibility now".
 */
export function VisibilityBuildBanner({
  build,
  manage,
}: {
  build: VisibilityBuildState;
  manage: boolean;
}) {
  const website = useWebsite();
  const { pending, problem, submit } = useSubmit();
  useRefreshWhileBuilding(build.job);
  if (build.pendingChanges === 0 && !build.catalogChangedSinceBuild) return null;
  const progress = buildProgress(build.job, 'visibility');
  const count = build.pendingChanges;
  const what = [
    ...(build.catalogChangedSinceBuild ? ['catalog changes'] : []),
    ...(count > 0
      ? [`${formatCount(count, website)} visibility rule ${count === 1 ? 'change' : 'changes'}`]
      : []),
  ].join(' and ');
  return (
    <Alert variant={progress ? 'info' : 'warning'} icon={<CircleAlert />}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <AlertTitle>Buyers do not see {what} yet</AlertTitle>
          <span className="text-meta">
            {progress ??
              (build.lastBuild
                ? `The storefront shows the catalog of the last visibility build (${formatDateTime(build.lastBuild.builtAt, website)}).`
                : 'No visibility build has run yet, so buyers see no products.')}
          </span>
        </div>
        {manage && !progress ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              void submit(buildVisibility, { title: 'Visibility build queued' });
            }}
          >
            <RefreshCw aria-hidden="true" />
            Build visibility now
          </Button>
        ) : null}
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
    </Alert>
  );
}
