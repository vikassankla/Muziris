import { createRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Clock, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { Field } from '../components/field.js';
import { ProblemAlert } from '../components/problem-view.js';
import { PendingPage } from '../components/states.js';
import {
  CodeInput,
  QrCode,
  RecoveryCodeList,
  SecretText,
  SignInCard,
} from '../components/two-factor.js';
import { Alert } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { ApiProblem, isApiProblem, SERVER_ERROR_TITLE } from '../lib/api.js';
import { confirmEnrolment, startEnrolment, verifyCode } from '../lib/endpoints.js';
import { safeRedirect } from '../lib/redirect.js';
import { formatRetryAfter } from '../lib/retry.js';
import { rootRoute } from './root.js';
import { useCountdown } from './sign-in.js';

// The second step of admin sign-in (ADR 0026): a code from the authenticator app, or a
// recovery code, and enrolment for an admin who has no app set up yet. Both run on the short
// two-factor session the password opened; when it has ended, the admin starts again.

/** The one message for a wrong code and a locked account, as for a wrong password. */
export const INVALID_CODE_MESSAGE =
  'The code is incorrect, or the account is temporarily locked. Try again in a few minutes.';

interface StepSearch {
  redirect?: string;
}

const validateSearch = (search: Record<string, unknown>): StepSearch => {
  const target = safeRedirect(search['redirect']);
  return target === undefined ? {} : { redirect: target };
};

export const signInCodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/code',
  validateSearch,
  component: CodePage,
});

export const signInEnrolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/enrol',
  validateSearch,
  component: EnrolPage,
});

function asProblem(error: unknown): ApiProblem {
  return isApiProblem(error)
    ? error
    : new ApiProblem({ status: 0, code: 'unexpected_error', title: SERVER_ERROR_TITLE });
}

/** What both steps do when the API answers: back to sign-in, or the signed-in page. */
function useStepNavigation(search: StepSearch) {
  const navigate = useNavigate();
  const router = useRouter();
  return {
    expired: () =>
      navigate({
        to: '/sign-in',
        search: { ...search, reason: 'two_factor_expired' as const },
        replace: true,
      }),
    signedIn: async () => {
      await router.invalidate();
      await navigate({ href: search.redirect ?? '/', replace: true });
    },
  };
}

/** The refusals the code fields show; an ended step goes back to sign-in instead. */
function CodeProblem({
  problem,
  secondsLeft,
}: {
  problem: ApiProblem | undefined;
  secondsLeft: number;
}) {
  if (problem === undefined) return null;
  if (problem.code === 'invalid_code') {
    return <Alert variant="destructive">{INVALID_CODE_MESSAGE}</Alert>;
  }
  if (problem.code === 'too_many_attempts') {
    return (
      <Alert variant="warning" icon={<Clock />}>
        Too many attempts.{' '}
        {secondsLeft > 0 ? `Try again in ${formatRetryAfter(secondsLeft)}.` : 'Try again later.'}
      </Alert>
    );
  }
  return <ProblemAlert problem={problem} />;
}

function CodePage() {
  const search = signInCodeRoute.useSearch();
  const step = useStepNavigation(search);
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const countdown = useCountdown();
  const locked = countdown.running && countdown.secondsLeft > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(undefined);
    countdown.stop();
    try {
      await verifyCode(recovery ? { recoveryCode: value } : { code: value });
      if (recovery) {
        toast.warning('You used a recovery code', {
          description: 'Each works once. Make new ones under Security in your profile menu.',
        });
      }
      await step.signedIn();
    } catch (error) {
      const answer = asProblem(error);
      if (answer.code === 'two_factor_expired') {
        await step.expired();
        return;
      }
      setValue('');
      setProblem(answer);
      if (answer.code === 'too_many_attempts' && answer.retryAfterSeconds !== undefined) {
        countdown.start(answer.retryAfterSeconds);
      } else {
        inputRef.current?.focus();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <SignInCard
      title={recovery ? 'Enter a recovery code' : 'Enter your code'}
      description={
        recovery
          ? 'Use one of the recovery codes you saved when you set up two-factor sign-in.'
          : 'Open your authenticator app and enter the 6-digit code for Muziris.'
      }
    >
      <CodeProblem problem={problem} secondsLeft={countdown.secondsLeft} />
      <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleSubmit(event)}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">{recovery ? 'Recovery code' : 'Authentication code'}</Label>
          {recovery ? (
            <Input
              ref={inputRef}
              id="code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={64}
              disabled={locked}
              className="font-mono"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          ) : (
            <CodeInput
              ref={inputRef}
              id="code"
              disabled={locked}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          )}
        </div>
        <Button type="submit" className="w-full" disabled={pending || locked}>
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
      <div className="flex flex-col items-start gap-1.5">
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          onClick={() => {
            setRecovery(!recovery);
            setValue('');
            setProblem(undefined);
          }}
        >
          {recovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
        </Button>
        <Link to="/sign-in" search={search} className="text-meta text-muted-foreground">
          Back to sign in
        </Link>
      </div>
      {recovery ? (
        <p className="m-0 text-xs text-muted-foreground">
          Lost your phone and your codes? Ask an administrator to reset your two-factor sign-in.
        </p>
      ) : null}
    </SignInCard>
  );
}

type Enrolment =
  | { step: 'loading' }
  | { step: 'failed'; problem: ApiProblem }
  | { step: 'scan'; secret: string; uri: string }
  | { step: 'codes'; codes: string[] };

function EnrolPage() {
  const search = signInEnrolRoute.useSearch();
  const step = useStepNavigation(search);
  const navigate = useNavigate();
  const [enrolment, setEnrolment] = useState<Enrolment>({ step: 'loading' });
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [saved, setSaved] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // Once per visit: a second start would replace the secret just shown.
    if (started.current) return;
    started.current = true;
    startEnrolment().then(
      (factor) => {
        setEnrolment({ step: 'scan', ...factor });
      },
      (error: unknown) => {
        const answer = asProblem(error);
        if (answer.code === 'two_factor_expired') void step.expired();
        else if (answer.code === 'already_enrolled') {
          void navigate({ to: '/sign-in/code', search, replace: true });
        } else setEnrolment({ step: 'failed', problem: answer });
      },
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per visit

  async function handleConfirm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(undefined);
    try {
      const done = await confirmEnrolment(code);
      setEnrolment({ step: 'codes', codes: done.recoveryCodes });
    } catch (error) {
      const answer = asProblem(error);
      if (answer.code === 'two_factor_expired') {
        await step.expired();
        return;
      }
      setCode('');
      setProblem(answer);
    } finally {
      setPending(false);
    }
  }

  if (enrolment.step === 'loading') return <PendingPage />;

  if (enrolment.step === 'failed') {
    return (
      <SignInCard title="Set up two-factor sign-in" description="Something went wrong.">
        <ProblemAlert problem={enrolment.problem} />
        <Link to="/sign-in" search={search} className="text-meta text-muted-foreground">
          Back to sign in
        </Link>
      </SignInCard>
    );
  }

  if (enrolment.step === 'codes') {
    return (
      <SignInCard
        wide
        title="Save your recovery codes"
        description="If you lose your phone, each code signs you in once. They are shown only now."
      >
        <RecoveryCodeList codes={enrolment.codes} />
        <div className="flex items-center gap-2">
          <Checkbox
            id="saved"
            checked={saved}
            onCheckedChange={(checked) => {
              setSaved(checked === true);
            }}
          />
          <Label htmlFor="saved">I have saved these codes somewhere safe</Label>
        </div>
        <Button className="w-full" disabled={!saved} onClick={() => void step.signedIn()}>
          Continue
        </Button>
      </SignInCard>
    );
  }

  return (
    <SignInCard
      wide
      title="Set up two-factor sign-in"
      description="Admins sign in with a code from an authenticator app as well as the password."
    >
      <Alert variant="info" icon={<ShieldAlert />}>
        You need to do this once, before any admin screen opens.
      </Alert>
      <ol className="m-0 flex list-none flex-col gap-5 p-0">
        <li className="flex flex-col gap-3">
          <p className="m-0">
            <span className="font-[600]">1.</span> Scan this QR code with an authenticator app, such
            as Google Authenticator, Microsoft Authenticator or 1Password.
          </p>
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <QrCode value={enrolment.uri} label="QR code for your authenticator app" />
            <SecretText secret={enrolment.secret} />
          </div>
        </li>
        <li className="flex flex-col gap-3">
          <p className="m-0">
            <span className="font-[600]">2.</span> Enter the 6-digit code the app shows.
          </p>
          {problem?.code === 'invalid_code' ? (
            <Alert variant="destructive">{INVALID_CODE_MESSAGE}</Alert>
          ) : problem ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <form className="flex flex-col gap-3.5" onSubmit={(event) => void handleConfirm(event)}>
            <Field label="Authentication code">
              {(props) => (
                <CodeInput
                  {...props}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                />
              )}
            </Field>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? 'Verifying…' : 'Verify and continue'}
            </Button>
          </form>
        </li>
      </ol>
      <Link to="/sign-in" search={search} className="text-meta text-muted-foreground">
        Back to sign in
      </Link>
    </SignInCard>
  );
}
