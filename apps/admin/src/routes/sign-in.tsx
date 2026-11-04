import { createRoute, useNavigate } from '@tanstack/react-router';
import { Clock, Lock } from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { ProblemAlert } from '../components/problem-view.js';
import { SignInCard } from '../components/two-factor.js';
import { Alert } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
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

interface SignInSearch {
  redirect?: string;
  reason?: 'session_ended' | 'two_factor_expired';
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    const target = safeRedirect(search['redirect']);
    return {
      ...(target === undefined ? {} : { redirect: target }),
      ...(search['reason'] === 'session_ended' || search['reason'] === 'two_factor_expired'
        ? { reason: search['reason'] }
        : {}),
    };
  },
  component: SignInPage,
});

/** A countdown in whole seconds, ticking once a second while it runs. */
export function useCountdown() {
  const [clock, setClock] = useState<{ until: number; now: number } | undefined>();
  useEffect(() => {
    if (clock === undefined) return undefined;
    const timer = setInterval(() => {
      setClock((c) => (c ? { ...c, now: Date.now() } : c));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [clock === undefined]); // eslint-disable-line react-hooks/exhaustive-deps -- restart only when it starts or stops
  return {
    running: clock !== undefined,
    secondsLeft: clock ? Math.max(0, Math.ceil((clock.until - clock.now) / 1000)) : 0,
    start: (seconds: number) => {
      const now = Date.now();
      setClock({ until: now + seconds * 1000, now });
    },
    stop: () => {
      setClock(undefined);
    },
  };
}

function SignInPage() {
  const search = signInRoute.useSearch();
  const navigate = useNavigate();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const countdown = useCountdown();
  const secondsLeft = countdown.secondsLeft;
  const locked = countdown.running && secondsLeft > 0;

  // Once the wait is over the form opens again and the rate-limit message goes away.
  const waitOver = countdown.running && secondsLeft === 0;
  const shownProblem = waitOver && problem?.code === 'too_many_attempts' ? undefined : problem;

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(undefined);
    countdown.stop();
    try {
      const { next } = await signIn(email, password);
      setPassword('');
      // The second factor (ADR 0026): the code, or enrolment the first time.
      await navigate({
        to: next === 'code' ? '/sign-in/code' : '/sign-in/enrol',
        search: search.redirect === undefined ? {} : { redirect: search.redirect },
      });
    } catch (error) {
      setPassword('');
      // Anything that is not an answer from the API gets the generic message, never the exception.
      const answer = isApiProblem(error)
        ? error
        : new ApiProblem({ status: 0, code: 'unexpected_error', title: SERVER_ERROR_TITLE });
      setProblem(answer);
      if (answer.code === 'too_many_attempts' && answer.retryAfterSeconds !== undefined) {
        countdown.start(answer.retryAfterSeconds);
      } else {
        // The password field is cleared and focused (SignIn board).
        passwordRef.current?.focus();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <SignInCard title="Sign in" description="For admin users. Buyers sign in on the storefront.">
      {shownProblem === undefined && search.reason === 'session_ended' ? (
        <Alert variant="info" icon={<Lock />}>
          Your session ended. Sign in again.
        </Alert>
      ) : shownProblem === undefined && search.reason === 'two_factor_expired' ? (
        <Alert variant="info" icon={<Clock />}>
          That took longer than five minutes. Sign in again.
        </Alert>
      ) : null}
      {shownProblem?.code === 'invalid_credentials' ? (
        <Alert variant="destructive">{INVALID_CREDENTIALS_MESSAGE}</Alert>
      ) : shownProblem?.code === 'too_many_attempts' ? (
        <Alert variant="warning" icon={<Clock />}>
          Too many sign-in attempts.{' '}
          {locked ? `Try again in ${formatRetryAfter(secondsLeft)}.` : 'Try again later.'}
        </Alert>
      ) : shownProblem ? (
        <ProblemAlert problem={shownProblem} />
      ) : null}
      <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleSubmit(event)}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            disabled={locked}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            ref={passwordRef}
            id="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            disabled={locked}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending || locked}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="m-0 text-xs text-muted-foreground">
        Forgot your password or need an account? Ask an administrator.
      </p>
    </SignInCard>
  );
}
