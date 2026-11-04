import { createRoute, Link } from '@tanstack/react-router';
import { CircleCheck } from 'lucide-react';
import { useEffect, useState, type SubmitEvent } from 'react';
import { ProblemAlert } from '../components/problem-view.js';
import { SignInCard } from '../components/two-factor.js';
import { Alert } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { ApiProblem, isApiProblem, SERVER_ERROR_TITLE } from '../lib/api.js';
import {
  acceptAdminInvitation,
  lookUpAdminInvitation,
  type PendingAdminInvitation,
} from '../lib/endpoints.js';
import { rootRoute } from './root.js';

// The page an admin invitation email links to (ADR 0028): /accept-invitation#token=…. The token
// is in the fragment, which browsers never send to a server, and is cleared from the address bar
// as soon as the page has read it. Accepting sets the password only; the admin then signs in and
// sets up two-factor sign-in (ADR 0026).

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

const NOT_VALID = new ApiProblem({
  status: 404,
  code: 'invitation_invalid',
  title: 'This invitation link is not valid',
  detail: 'It may have been used already or expired. Ask an administrator to send it again.',
});

type Step =
  | { kind: 'loading' }
  | { kind: 'found'; invitation: PendingAdminInvitation }
  | { kind: 'refused'; problem: ApiProblem }
  | { kind: 'accepted'; email: string };

function AcceptInvitationPage() {
  const [token] = useState(takeToken);
  const [step, setStep] = useState<Step>(() =>
    token ? { kind: 'loading' } : { kind: 'refused', problem: NOT_VALID },
  );
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    lookUpAdminInvitation(token).then(
      (invitation) => {
        if (live) setStep({ kind: 'found', invitation });
      },
      (error: unknown) => {
        if (live) setStep({ kind: 'refused', problem: asProblem(error) });
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
      const { email } = await acceptAdminInvitation(token, password);
      setPassword('');
      setStep({ kind: 'accepted', email });
    } catch (error) {
      const answer = asProblem(error);
      if (answer.code === 'invitation_invalid') setStep({ kind: 'refused', problem: answer });
      else setProblem(answer);
    } finally {
      setPending(false);
    }
  }

  if (step.kind === 'loading') {
    return (
      <SignInCard title="Accept your invitation" description="Checking your invitation…">
        {null}
      </SignInCard>
    );
  }
  if (step.kind === 'refused') {
    return (
      <SignInCard title="This invitation can’t be used" description={step.problem.detail ?? ''}>
        <Alert variant="warning">{step.problem.title}</Alert>
        <Button variant="outline" asChild>
          <Link to="/sign-in">Go to sign in</Link>
        </Button>
      </SignInCard>
    );
  }
  if (step.kind === 'accepted') {
    return (
      <SignInCard
        title="Your password is set"
        description={`Sign in as ${step.email}. You will set up two-factor sign-in with an authenticator app next.`}
      >
        <Alert variant="info" icon={<CircleCheck />}>
          Keep your phone with an authenticator app at hand.
        </Alert>
        <Button asChild className="w-full">
          <Link to="/sign-in">Sign in</Link>
        </Button>
      </SignInCard>
    );
  }
  const { invitation } = step;
  return (
    <SignInCard
      title={`Welcome, ${invitation.displayName}`}
      description={`Choose a password for ${invitation.email}. Then you sign in and set up two-factor sign-in.`}
    >
      {problem ? <ProblemAlert problem={problem} /> : null}
      <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleSubmit(event)}>
        {/* For password managers: the account this password belongs to. */}
        <input type="email" autoComplete="username" value={invitation.email} readOnly hidden />
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
          {pending ? 'Setting your password…' : 'Set password'}
        </Button>
      </form>
    </SignInCard>
  );
}
