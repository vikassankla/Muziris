import { createRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useState, type SubmitEvent } from 'react';
import { ProblemAlert } from '../components/problem-view.js';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { ApiProblem, isApiProblem, SERVER_ERROR_TITLE } from '../lib/api.js';
import { signIn } from '../lib/endpoints.js';
import { safeRedirect } from '../lib/redirect.js';
import { formatRetryAfter } from '../lib/retry.js';
import { rootRoute } from './root.js';

/** The one message for a wrong email, a wrong password or a locked account (ADR 0005). */
export const INVALID_CREDENTIALS_MESSAGE =
  'Email or password is incorrect, or the account is temporarily locked. Try again in a few minutes.';

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search['redirect']);
    return target === undefined ? {} : { redirect: target };
  },
  component: SignInPage,
});

function SignInError({ problem }: { problem: ApiProblem }) {
  switch (problem.code) {
    case 'invalid_credentials':
      return (
        <Alert variant="destructive">
          <AlertTitle>Could not sign in</AlertTitle>
          <AlertDescription>{INVALID_CREDENTIALS_MESSAGE}</AlertDescription>
        </Alert>
      );
    case 'too_many_attempts':
      return (
        <Alert variant="destructive">
          <AlertTitle>Too many sign-in attempts</AlertTitle>
          <AlertDescription>
            {problem.retryAfterSeconds === undefined
              ? 'Try again later.'
              : `Try again in ${formatRetryAfter(problem.retryAfterSeconds)}.`}
          </AlertDescription>
        </Alert>
      );
    default:
      return <ProblemAlert problem={problem} />;
  }
}

function SignInPage() {
  const search = signInRoute.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(undefined);
    try {
      await signIn(email, password);
      setPassword('');
      await router.invalidate();
      await navigate({ href: search.redirect ?? '/', replace: true });
    } catch (error) {
      setPassword('');
      // Anything that is not an answer from the API gets the generic message, never the exception.
      setProblem(
        isApiProblem(error)
          ? error
          : new ApiProblem({ status: 0, code: 'unexpected_error', title: SERVER_ERROR_TITLE }),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Muziris admin</CardTitle>
          <CardDescription>Use the email and password of your admin user.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
            {problem ? <SignInError problem={problem} /> : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
