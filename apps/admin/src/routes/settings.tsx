import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { Settings2, X } from 'lucide-react';
import { useEffect, useState, type SubmitEvent } from 'react';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Switch } from '../components/ui/switch.js';
import {
  allBuyerRoles,
  allCustomerGroups,
  clearSettingValue,
  getCustomer,
  listSettings,
  setSettingValue,
  type BuyerRole,
  type ScopeType,
  type Setting,
  type SettingEditor,
} from '../lib/endpoints.js';
import { formatAmount, type DisplayContext } from '../lib/format.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite, useWebsites, websiteChoice } from '../lib/website.js';
import { authedRoute } from './authed.js';

// Settings (ADR 0021): every setting an admin may change, with the value that applies to a
// website, customer group or customer and where that value comes from. An override applies at
// one scope; clearing it falls back to the next one up.

interface SettingsSearch {
  /** A website id, or "all" for no website. Left out, the top bar's website is used. */
  website?: string;
  group?: string;
  customer?: string;
  /** Show only settings changed from their default for this context. */
  overridden?: boolean;
}

const ALL = 'all';
const NO_GROUP = '__none';

function settingsSearch(search: Record<string, unknown>): SettingsSearch {
  const out: SettingsSearch = {};
  const text = (key: string) => {
    const value = search[key];
    return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : undefined;
  };
  const website = text('website');
  if (website !== undefined) out.website = website;
  const group = text('group');
  if (group !== undefined) out.group = group;
  const customer = text('customer');
  if (customer !== undefined) out.customer = customer;
  if (search['overridden'] === true || search['overridden'] === 'true') out.overridden = true;
  return out;
}

export const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  validateSearch: settingsSearch,
  loaderDeps: ({ search }) => ({
    website: search.website,
    group: search.group,
    customer: search.customer,
  }),
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal;
    const customer = deps.customer ? await getCustomer(deps.customer, signal) : undefined;
    const [settings, groups, roles] = await Promise.all([
      listSettings(
        {
          websiteId: deps.website === ALL ? undefined : deps.website,
          customerGroupId: customer ? undefined : deps.group,
          customerId: customer?.id,
        },
        signal,
      ),
      allCustomerGroups(signal),
      allBuyerRoles(signal),
    ]);
    return { settings, groups, roles, customer };
  },
  component: SettingsPage,
});

const SOURCE_LABELS: Record<Setting['source'], string> = {
  default: 'Default',
  global: 'Global',
  organization: 'Organization',
  website: 'Website',
  customer_group: 'Customer group',
  customer: 'Customer',
};

/** Most specific first, as the dialog offers them. */
const SCOPE_ORDER: readonly ScopeType[] = [
  'customer',
  'customer_group',
  'website',
  'organization',
  'global',
];

interface ContextScope {
  type: ScopeType;
  id?: string;
  label: string;
}

function formatValue(
  editor: SettingEditor,
  value: unknown,
  roles: readonly BuyerRole[],
  display: DisplayContext | undefined,
): string {
  switch (editor.kind) {
    case 'integer':
      return `${String(value)}${editor.unit ? ` ${editor.unit}` : ''}`;
    case 'money': {
      const amount = (value as { amount?: unknown } | null)?.amount;
      if (typeof amount !== 'string') return '';
      if (!display) return `${amount} in each website’s currency`;
      try {
        return formatAmount(amount, display);
      } catch (error) {
        // A value saved before the API checked decimals: show it, so it can be corrected.
        if (error instanceof RangeError) return `${amount} ${display.currency}`;
        throw error;
      }
    }
    case 'choices': {
      const chosen = Array.isArray(value) ? (value as unknown[]) : [value];
      const labels = editor.options.filter((o) => chosen.includes(o.value)).map((o) => o.label);
      return labels.length > 0 ? labels.join(', ') : 'None';
    }
    case 'email':
      return typeof value === 'string' && value !== '' ? value : 'None (no email is sent)';
    case 'boolean':
      return value === true ? 'On' : 'Off';
    case 'buyer_role':
      return typeof value === 'string'
        ? (roles.find((r) => r.id === value)?.name ?? 'A deleted buyer role')
        : 'No buyer role';
    case 'text':
      return typeof value === 'string' ? value : '';
  }
}

/** The form's state for a value, and back. */
function toDraft(editor: SettingEditor, value: unknown): unknown {
  switch (editor.kind) {
    case 'integer':
      return String(value);
    case 'money':
      return (value as { amount?: string } | null)?.amount ?? '0';
    case 'choices':
      return Array.isArray(value) ? value : [value];
    case 'text':
    case 'email':
    case 'boolean':
    case 'buyer_role':
      return value;
  }
}

function fromDraft(editor: SettingEditor, draft: unknown): unknown {
  switch (editor.kind) {
    case 'integer':
      return Number(draft);
    case 'money':
      return { amount: draft };
    case 'choices':
      return editor.multiple ? draft : (draft as unknown[])[0];
    case 'text':
    case 'email':
    case 'boolean':
    case 'buyer_role':
      return draft;
  }
}

function ValueEditor({
  id,
  editor,
  draft,
  onDraft,
  roles,
  currency,
}: {
  id: string;
  editor: SettingEditor;
  draft: unknown;
  onDraft: (draft: unknown) => void;
  roles: readonly BuyerRole[];
  currency: string | undefined;
}) {
  switch (editor.kind) {
    case 'integer':
      return (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            required
            className="num w-32"
            min={editor.min}
            max={editor.max}
            step={1}
            value={draft as string}
            onChange={(e) => {
              onDraft(e.target.value);
            }}
          />
          {editor.unit ? (
            <span className="text-meta text-muted-foreground">{editor.unit}</span>
          ) : null}
        </div>
      );
    case 'money':
      return (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            inputMode="decimal"
            required
            className="num w-40"
            pattern="\d{1,12}(\.\d{1,6})?"
            value={draft as string}
            onChange={(e) => {
              onDraft(e.target.value);
            }}
          />
          <span className="text-meta text-muted-foreground">
            {currency ?? 'in each website’s currency'}
          </span>
        </div>
      );
    case 'text':
      return (
        <Input
          id={id}
          required
          className="font-mono"
          {...(editor.pattern ? { pattern: editor.pattern.replace(/^\^|\$$/g, '') } : {})}
          value={draft as string}
          onChange={(e) => {
            onDraft(e.target.value);
          }}
        />
      );
    case 'email':
      return (
        <Input
          id={id}
          type="email"
          required={!editor.allowEmpty}
          maxLength={254}
          value={draft as string}
          onChange={(e) => {
            onDraft(e.target.value);
          }}
        />
      );
    case 'boolean':
      return (
        <Switch
          id={id}
          checked={draft === true}
          onCheckedChange={(checked) => {
            onDraft(checked);
          }}
        />
      );
    case 'buyer_role':
      return (
        <Select
          value={typeof draft === 'string' ? draft : NO_GROUP}
          onValueChange={(next) => {
            onDraft(next === NO_GROUP ? null : next);
          }}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUP}>No buyer role</SelectItem>
            {roles.map((role) => (
              <SelectItem key={role.id} value={role.id}>
                {role.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'choices': {
      const chosen = draft as string[];
      if (!editor.multiple) {
        return (
          <Select
            value={chosen[0] ?? ''}
            onValueChange={(next) => {
              onDraft([next]);
            }}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {editor.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      return (
        <div id={id} role="group" className="flex flex-col gap-2">
          {editor.options.map((o) => (
            <label key={o.value} className="flex items-center gap-2.5">
              <Checkbox
                checked={chosen.includes(o.value)}
                onCheckedChange={(checked) => {
                  onDraft(
                    checked === true
                      ? editor.options
                          .map((x) => x.value)
                          .filter((v) => v === o.value || chosen.includes(v))
                      : chosen.filter((v) => v !== o.value),
                  );
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
  }
}

function OverrideDialog({
  setting,
  scopes,
  roles,
  currency,
  onClose,
}: {
  setting: Setting;
  /** The scopes of the current context this setting allows, most specific first. */
  scopes: readonly ContextScope[];
  roles: readonly BuyerRole[];
  currency: string | undefined;
  onClose: () => void;
}) {
  const [scopeType, setScopeType] = useState<ScopeType | undefined>(scopes[0]?.type);
  const [draft, setDraft] = useState(() => toDraft(setting.editor, setting.value));
  const { pending, problem, submit } = useSubmit();
  const scope = scopes.find((s) => s.type === scopeType);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scope) return;
    const done = await submit(
      async () => {
        await setSettingValue(
          setting.key,
          { type: scope.type, ...(scope.id ? { id: scope.id } : {}) },
          fromDraft(setting.editor, draft),
        );
        return true;
      },
      { title: 'Setting saved', description: `${setting.label} for ${scope.label}` },
    );
    if (done) onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{setting.label}</DialogTitle>
          <DialogDescription>{setting.description}.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem ? <ProblemAlert problem={problem} /> : null}
          <Field
            label="Applies to"
            hint="More specific scopes win: customer, then customer group, then website, then organization, then global."
          >
            {({ id }) => (
              <Select
                value={scopeType ?? ''}
                onValueChange={(next) => {
                  setScopeType(next as ScopeType);
                }}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((s) => (
                    <SelectItem key={s.type} value={s.type}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Value">
            {({ id }) => (
              <ValueEditor
                id={id}
                editor={setting.editor}
                draft={draft}
                onDraft={setDraft}
                roles={roles}
                currency={currency}
              />
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !scope}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsPage() {
  const { settings, groups, roles, customer } = settingsRoute.useLoaderData();
  const search = settingsRoute.useSearch();
  const navigate = useNavigate();
  const session = useSession();
  const manage = can(session, 'setting.manage');
  const topBarWebsite = useWebsite();
  const websites = useWebsites();
  const [editing, setEditing] = useState<Setting | undefined>();
  const clear = useSubmit();

  // The screen starts from the website chosen in the top bar.
  useEffect(() => {
    if (search.website === undefined) {
      void navigate({
        to: '.',
        search: (prev: SettingsSearch) => ({ ...prev, website: topBarWebsite.id || ALL }),
        replace: true,
      });
    }
  }, [search.website, topBarWebsite.id, navigate]);

  const website = websites.find((w) => w.id === search.website);
  const display = website ? websiteChoice(website) : undefined;
  const groupId = customer ? (customer.groupId ?? undefined) : search.group;
  const group = groups.find((g) => g.id === groupId);

  const contextScopes: ContextScope[] = [];
  if (customer) contextScopes.push({ type: 'customer', id: customer.id, label: customer.name });
  if (group) contextScopes.push({ type: 'customer_group', id: group.id, label: group.name });
  if (website) contextScopes.push({ type: 'website', id: website.id, label: website.name });
  contextScopes.push({ type: 'organization', label: 'The organization' });
  contextScopes.push({ type: 'global', label: 'Global' });
  const scopesFor = (setting: Setting) =>
    SCOPE_ORDER.flatMap((type) =>
      setting.allowedScopes.includes(type) ? contextScopes.filter((s) => s.type === type) : [],
    );

  const shown = search.overridden ? settings.filter((s) => s.source !== 'default') : settings;
  const grouped = [...new Set(shown.map((s) => s.group))].map((name) => ({
    name,
    settings: shown.filter((s) => s.group === name),
  }));

  const setSearch = (change: { [K in keyof SettingsSearch]?: SettingsSearch[K] | undefined }) => {
    void navigate({
      to: '.',
      search: (prev: SettingsSearch) =>
        settingsSearch(
          Object.fromEntries(
            Object.entries({ ...prev, ...change }).filter(
              ([, value]) => value !== undefined && value !== false,
            ),
          ),
        ),
    });
  };

  function clearOverride(setting: Setting) {
    const scope = contextScopes.find((s) => s.type === setting.source);
    if (!scope) return;
    void clear.submit(
      async () => {
        await clearSettingValue(setting.key, {
          type: scope.type,
          ...(scope.id ? { id: scope.id } : {}),
        });
        return true;
      },
      { title: 'Override cleared', description: `${setting.label} for ${scope.label}` },
    );
  }

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'System' }, { label: 'Settings' }]} />
      <PageHeader
        title="Settings"
        description="The values that apply where you are looking, and where each comes from. Secrets such as payment keys are set in the environment, not here."
      />
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Website" className="w-56">
          {({ id }) => (
            <Select
              value={search.website ?? ALL}
              onValueChange={(next) => {
                setSearch({ website: next });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>No website</SelectItem>
                {websites.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field
          label="Customer group"
          className="w-56"
          hint={customer ? 'The customer’s own group.' : undefined}
        >
          {({ id }) => (
            <Select
              value={groupId ?? NO_GROUP}
              disabled={customer !== undefined}
              onValueChange={(next) => {
                setSearch({ group: next === NO_GROUP ? undefined : next });
              }}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>No customer group</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {customer ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-[550]">Customer</span>
            <span className="flex h-control items-center gap-1.5">
              <Link
                to="/customers/$customerId"
                params={{ customerId: customer.id }}
                className="font-semibold"
              >
                {customer.name}
              </Link>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Stop looking at this customer"
                onClick={() => {
                  setSearch({ customer: undefined });
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          </div>
        ) : null}
        <label className="flex h-control items-center gap-2.5">
          <Switch
            checked={search.overridden === true}
            onCheckedChange={(checked) => {
              setSearch({ overridden: checked });
            }}
          />
          Only changed settings
        </label>
      </div>
      {clear.problem ? <ProblemAlert problem={clear.problem} /> : null}
      {grouped.length === 0 ? (
        <EmptyState
          icon={Settings2}
          title="Every setting has its default here"
          description="Turn off “Only changed settings” to see them all."
        />
      ) : (
        grouped.map(({ name, settings: inGroup }) => (
          <Card key={name}>
            <CardHeader>
              <CardTitle>{name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border p-0">
              {inGroup.map((setting) => {
                const clearable = manage && contextScopes.some((s) => s.type === setting.source);
                return (
                  <div
                    key={setting.key}
                    className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3"
                    aria-label={setting.label}
                    role="group"
                  >
                    <div className="flex min-w-60 flex-1 flex-col gap-0.5">
                      <span className="font-semibold">{setting.label}</span>
                      <span className="text-meta text-muted-foreground">{setting.description}</span>
                    </div>
                    <span className="num min-w-48">
                      {formatValue(setting.editor, setting.value, roles, display)}
                    </span>
                    <Badge variant={setting.source === 'default' ? 'neutral' : 'info'}>
                      {SOURCE_LABELS[setting.source]}
                    </Badge>
                    {manage ? (
                      <div className="flex gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(setting);
                          }}
                        >
                          Change
                        </Button>
                        {clearable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={clear.pending}
                            onClick={() => {
                              clearOverride(setting);
                            }}
                          >
                            Clear
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {setting.warnings.length > 0 ? (
                      <Alert variant="warning" className="basis-full">
                        {setting.warnings.map((warning) => (
                          <AlertDescription key={warning}>{warning}</AlertDescription>
                        ))}
                      </Alert>
                    ) : null}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))
      )}
      {editing ? (
        <OverrideDialog
          key={editing.key}
          setting={editing}
          scopes={scopesFor(editing)}
          roles={roles}
          currency={website?.defaultCurrency}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      ) : null}
    </Page>
  );
}
