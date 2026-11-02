import { createRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useState, type SubmitEvent } from 'react';
import { Alert } from '../components/ui/alert.js';
import { Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { BrandMark } from '../components/header.js';
import {
  acceptInvitation,
  ApiProblem,
  isApiProblem,
  lookUpInvitation,
  SERVER_ERROR_TITLE,
  type PendingInvitation,
} from '../lib/api.js';
import { forgetShell } from '../lib/session.js';
import { rootRoute } from './root.js';

// The page an invitation email links to (ADR 0020): /accept-invitation#token=…. The token is in
// the fragment, which browsers never send to a server, and is cleared from the address bar as
// soon as the page has read it.

export const acceptInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invitation',
  component: AcceptInvitationPage,
});

/** Reads the token from the fragment once, and takes it out of the address bar and history. */
function takeToken(): string | undefined {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? undefined;
  if (window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return token === '' ? undefined : token;
}

function asProblem(error: unknown): ApiProblem {
  return isApiProblem(error)
    ? error
    : new ApiProblem({ status: 0, code: 'unexpected_error', title: SERVER_ERROR_TITLE });
}

type Lookup =
  | { kind: 'loading' }
  | { kind: 'found'; invitation: PendingInvitation }
  | { kind: 'refused'; problem: ApiProblem };

function AcceptInvitationPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [token] = useState(takeToken);
  const [lookup, setLookup] = useState<Lookup>(() =>
    token
      ? { kind: 'loading' }
      : {
          kind: 'refused',
          problem: new ApiProblem({
            status: 404,
            code: 'invitation_not_found',
            title: 'This invitation link is not valid',
          }),
        },
  );
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    lookUpInvitation(token).then(
      (invitation) => {
        if (live) setLookup({ kind: 'found', invitation });
      },
      (error: unknown) => {
        if (live) setLookup({ kind: 'refused', problem: asProblem(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setProblem(undefined);
    try {
      const user = await acceptInvitation(token, password);
      setPassword('');
      forgetShell();
      await router.invalidate();
      await navigate({ to: user ? '/' : '/sign-in', replace: true });
    } catch (error) {
      setProblem(asProblem(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <div className="flex w-full max-w-[420px] flex-col gap-5 rounded-lg border bg-card px-7 py-8 shadow-overlay">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-base font-semibold">Muziris</span>
          <Tag>Shop</Tag>
        </div>
        {lookup.kind === 'loading' ? (
          <p className="m-0 text-meta text-muted-foreground">Checking your invitation…</p>
        ) : lookup.kind === 'refused' ? (
          <>
            <h1 className="m-0 text-xl font-[650]">This invitation can’t be used</h1>
            <Alert variant="warning">{lookup.problem.title}</Alert>
            <p className="m-0 text-meta text-muted-foreground">
              Ask the person who invited you to send it again, or sign in if you already have an
              account.
            </p>
            <Button variant="outline" onClick={() => void navigate({ to: '/sign-in' })}>
              Go to sign in
            </Button>
          </>
        ) : (
          <>
            <div>
              <h1 className="m-0 text-xl font-[650]">Welcome, {lookup.invitation.displayName}</h1>
              <p className="m-0 mt-1 text-meta text-muted-foreground">
                {lookup.invitation.customerName
                  ? `You are invited to order for ${lookup.invitation.customerName}. `
                  : ''}
                Choose a password for {lookup.invitation.email}.
              </p>
            </div>
            {problem ? (
              <Alert variant={problem.code === 'too_many_attempts' ? 'warning' : 'destructive'}>
                {problem.title}
              </Alert>
            ) : null}
            <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleSubmit(event)}>
              {/* For password managers: the account this password belongs to. */}
              <input
                type="email"
                autoComplete="username"
                value={lookup.invitation.email}
                readOnly
                hidden
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-password">Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={1024}
                  aria-describedby="password-hint"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                />
                <p id="password-hint" className="m-0 text-xs text-muted-foreground">
                  12 characters or more. A short sentence is easy to remember.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? 'Setting up your account…' : 'Create account and sign in'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
