import { createRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useRef, useState, type SubmitEvent } from 'react';
import { Alert } from '../components/ui/alert.js';
import { Tag } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { BrandMark } from '../components/header.js';
import { ApiProblem, isApiProblem, SERVER_ERROR_TITLE, signIn } from '../lib/api.js';
import { safeRedirect } from '../lib/redirect.js';
import { forgetShell } from '../lib/session.js';
import { rootRoute } from './root.js';

/** The one message for a wrong email, a wrong password or a locked account (ADR 0005). */
export const INVALID_CREDENTIALS_MESSAGE =
  'Email or password is incorrect, or the account is temporarily locked. Try again in a few minutes.';

export const SESSION_ENDED_MESSAGE =
  'You were signed out after a period without activity. Sign in again to carry on where you were.';

interface SignInSearch {
  redirect?: string;
  reason?: 'session_ended';
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    const target = safeRedirect(search['redirect']);
    return {
      ...(target === undefined ? {} : { redirect: target }),
      ...(search['reason'] === 'session_ended' ? { reason: 'session_ended' as const } : {}),
    };
  },
  component: SignInPage,
});

function SignInPage() {
  const search = signInRoute.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const passwordRef = useRef<HTMLInputElement>(null);
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
      forgetShell();
      await router.invalidate();
      await navigate({ href: search.redirect ?? '/', replace: true });
    } catch (error) {
      setPassword('');
      setProblem(
        isApiProblem(error)
          ? error
          : new ApiProblem({ status: 0, code: 'unexpected_error', title: SERVER_ERROR_TITLE }),
      );
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-lg border bg-card px-7 py-8 shadow-overlay">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-base font-semibold">Muziris</span>
          <Tag>Shop</Tag>
        </div>
        <div>
          <h1 className="m-0 text-xl font-[650]">Sign in to order</h1>
          <p className="m-0 mt-1 text-meta text-muted-foreground">
            See your catalogue and your company’s prices.
          </p>
        </div>
        {problem === undefined && search.reason === 'session_ended' ? (
          <Alert variant="info">{SESSION_ENDED_MESSAGE}</Alert>
        ) : null}
        {problem?.code === 'invalid_credentials' ? (
          <Alert variant="destructive">{INVALID_CREDENTIALS_MESSAGE}</Alert>
        ) : problem?.code === 'too_many_attempts' ? (
          <Alert variant="warning">{problem.title}</Alert>
        ) : problem ? (
          <Alert variant="destructive">{problem.title}</Alert>
        ) : null}
        <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Work email</Label>
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              ref={passwordRef}
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
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="m-0 text-xs text-muted-foreground">
          No account yet? Ask the person who manages buying at your company to invite you.
        </p>
      </div>
    </div>
  );
}
