import { Link } from '@tanstack/react-router';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  buildVisibility,
  listVisibilityRules,
  type RuleSubject,
  type RuleTarget,
  type Visibility,
  type VisibilityBuildState,
  type VisibilityRule,
} from '../lib/endpoints.js';
import { formatCount, formatDateTime } from '../lib/format.js';
import { buildProgress, useRefreshWhileBuilding } from '../lib/jobs.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { ProblemAlert } from './problem-view.js';
import { Alert, AlertTitle } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';

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

export const SUBJECT_LABELS: Record<RuleSubject, string> = {
  product: 'Product',
  category: 'Category',
};
export const TARGET_LABELS: Record<RuleTarget, string> = {
  website: 'Everyone on the website',
  customer_group: 'Customer group',
  customer: 'Customer',
};
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  visible: 'Visible',
  hidden: 'Hidden',
};

/** "Bearings · 6204 Ball bearing" or "Power transmission / Bearings". */
export function subjectLabel(rule: VisibilityRule): string {
  if (rule.subjectName === null) return `${SUBJECT_LABELS[rule.subject]} ${rule.subjectId}`;
  return rule.subjectSku ? `${rule.subjectSku} · ${rule.subjectName}` : rule.subjectName;
}

/** "Everyone on Muziris India", or the customer group's or customer's name. */
export function targetLabel(rule: VisibilityRule): string {
  if (rule.target === 'website') return `Everyone on ${rule.targetName ?? 'the website'}`;
  return rule.targetName ?? `${TARGET_LABELS[rule.target]} ${rule.targetId}`;
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return (
    <Badge variant={visibility === 'visible' ? 'success' : 'neutral'}>
      {VISIBILITY_LABELS[visibility]}
    </Badge>
  );
}

const CARD_LIMIT = 5;

/**
 * The rules on one product, or for one customer, on the website in the top bar (ADR 0027),
 * linking to the Visibility screen filtered to them.
 */
export function VisibilityRulesCard(
  props:
    { productId: string; customerId?: undefined } | { customerId: string; productId?: undefined },
) {
  const website = useWebsite();
  const [rules, setRules] = useState<{
    websiteId: string;
    items: VisibilityRule[];
    more: boolean;
  }>();
  const { productId, customerId } = props;
  const filter = productId === undefined ? { targetId: customerId } : { subjectId: productId };

  useEffect(() => {
    if (website.id === '') return;
    const controller = new AbortController();
    listVisibilityRules(
      {
        websiteId: website.id,
        limit: 25,
        ...(productId === undefined ? { targetId: customerId } : { subjectId: productId }),
      },
      controller.signal,
    )
      .then((page) => {
        setRules({
          websiteId: website.id,
          items: page.items.slice(0, CARD_LIMIT),
          more: page.items.length > CARD_LIMIT || page.nextAfter !== null,
        });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [website.id, productId, customerId]);

  if (website.id === '') return null;
  const loaded = rules?.websiteId === website.id ? rules : undefined;
  const what = props.productId === undefined ? 'for this customer' : 'on this product';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Visibility</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loaded === undefined ? null : loaded.items.length === 0 ? (
          <p className="m-0 text-meta text-muted-foreground">
            No visibility rules {what} on {website.name}.{' '}
            {props.productId === undefined
              ? 'Its buyers see what its customer group and the website allow.'
              : 'Buyers see it unless a rule on one of its categories hides it.'}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {loaded.items.map((rule) => (
              <li key={rule.id} className="flex items-center gap-2">
                <VisibilityBadge visibility={rule.visibility} />
                <span className="text-meta">
                  {props.productId === undefined
                    ? subjectLabel(rule)
                    : `For ${targetLabel(rule).replace(/^Everyone/, 'everyone')}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link
          to="/visibility"
          search={{ website: website.id, ...filter }}
          className="text-meta self-start"
        >
          {loaded?.more ? 'See all rules' : 'Open in Visibility'}
        </Link>
      </CardContent>
    </Card>
  );
}
