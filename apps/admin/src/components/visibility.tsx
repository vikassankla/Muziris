import { CircleAlert, RefreshCw } from 'lucide-react';
import { buildVisibility, type VisibilityBuildState } from '../lib/endpoints.js';
import { formatCount, formatDateTime } from '../lib/format.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { ProblemAlert } from './problem-view.js';
import { Alert, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';

/**
 * Says when buyers do not see the catalog as it is now, with "Build visibility now" for a
 * visibility manager. Products, categories and visibility rules reach buyers only after a build
 * (ADR 0012).
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
  if (build.pendingChanges === 0 && !build.catalogChangedSinceBuild) return null;
  const count = build.pendingChanges;
  const what = [
    ...(build.catalogChangedSinceBuild ? ['catalog changes'] : []),
    ...(count > 0
      ? [`${formatCount(count, website)} visibility rule ${count === 1 ? 'change' : 'changes'}`]
      : []),
  ].join(' and ');
  return (
    <Alert variant="warning" icon={<CircleAlert />}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <AlertTitle>Buyers do not see {what} yet</AlertTitle>
          <span className="text-meta">
            {build.lastBuild
              ? `The storefront shows the catalog of the last visibility build (${formatDateTime(build.lastBuild.builtAt, website)}).`
              : 'No visibility build has run yet, so buyers see no products.'}
          </span>
        </div>
        {manage ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              void submit(buildVisibility, { title: 'Visibility built' });
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
