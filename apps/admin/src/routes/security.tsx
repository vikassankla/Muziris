import { createRoute } from '@tanstack/react-router';
import { KeyRound, Smartphone } from 'lucide-react';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { CodeInput, QrCode, RecoveryCodeList, SecretText } from '../components/two-factor.js';
import { Alert } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
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
  confirmPhoneMove,
  getTwoFactor,
  newRecoveryCodes,
  startPhoneMove,
} from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';
import { INVALID_CODE_MESSAGE } from './sign-in-two-factor.js';

// The signed-in admin's own two-factor sign-in (ADR 0026): new recovery codes, and moving to a
// new phone. Each needs the password and a current code, and signs the admin out everywhere
// else. Every admin must have it, so there is no switch to turn it off; an administrator can
// reset it for an admin who has lost their phone.

/** At or below this many unused recovery codes, the page suggests new ones. */
const FEW_CODES = 3;

export const securityRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/account/security',
  loader: ({ abortController }) => getTwoFactor(abortController.signal),
  component: SecurityPage,
});

function SecurityPage() {
  const status = securityRoute.useLoaderData();
  const website = useWebsite();
  const [dialog, setDialog] = useState<'codes' | 'phone' | undefined>();
  const few = status.recoveryCodesLeft <= FEW_CODES;

  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Your profile' }, { label: 'Security' }]} />
      <PageHeader
        title="Security"
        description="You sign in with your password and a code from an authenticator app."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4" aria-hidden="true" />
            Authenticator app
          </CardTitle>
          <CardDescription>
            {status.confirmedAt
              ? `Set up on ${formatDate(status.confirmedAt, website)}.`
              : 'Not set up.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant="success">On</Badge>
          <Button
            variant="outline"
            className="ml-auto"
            onClick={() => {
              setDialog('phone');
            }}
          >
            Move to a new phone
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden="true" />
            Recovery codes
          </CardTitle>
          <CardDescription>
            Each signs you in once if you lose your phone. {status.recoveryCodesLeft} of 10 left.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {few ? (
            <Alert variant="warning">
              {status.recoveryCodesLeft === 0
                ? 'You have no recovery codes left. Make new ones now.'
                : 'You are running out of recovery codes. Make new ones.'}
            </Alert>
          ) : null}
          <div className="flex">
            <Button
              variant="outline"
              className="ml-auto"
              onClick={() => {
                setDialog('codes');
              }}
            >
              New recovery codes
            </Button>
          </div>
        </CardContent>
      </Card>
      <NewCodesDialog
        open={dialog === 'codes'}
        onOpenChange={(open) => {
          setDialog(open ? 'codes' : undefined);
        }}
      />
      <NewPhoneDialog
        open={dialog === 'phone'}
        onOpenChange={(open) => {
          setDialog(open ? 'phone' : undefined);
        }}
      />
    </Page>
  );
}

/** Shows a refusal from the password and code check. */
function ChangeProblem({ problem }: { problem: ReturnType<typeof useSubmit>['problem'] }) {
  if (problem === undefined) return null;
  if (problem.code === 'invalid_code') {
    return (
      <Alert variant="destructive">
        The password or code is incorrect, or the account is temporarily locked.
      </Alert>
    );
  }
  return <ProblemAlert problem={problem} />;
}

/** The password and a current code, which every change asks for. */
function PasswordAndCode({
  password,
  code,
  onPassword,
  onCode,
}: {
  password: string;
  code: string;
  onPassword: (value: string) => void;
  onCode: (value: string) => void;
}) {
  return (
    <>
      <Field label="Password">
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(event) => {
              onPassword(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Code from your authenticator app">
        {(props) => (
          <CodeInput
            {...props}
            value={code}
            onChange={(event) => {
              onCode(event.target.value);
            }}
          />
        )}
      </Field>
    </>
  );
}

function CodesShown({ codes, onDone }: { codes: string[]; onDone: () => void }): ReactNode {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Save your new recovery codes</DialogTitle>
        <DialogDescription>
          Your old codes no longer work. These are shown only now. You have been signed out
          everywhere else.
        </DialogDescription>
      </DialogHeader>
      <RecoveryCodeList codes={codes} />
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

function NewCodesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | undefined>();
  const { pending, problem, setProblem, submit } = useSubmit();

  function close(next: boolean) {
    if (!next) {
      setPassword('');
      setCode('');
      setCodes(undefined);
      setProblem(undefined);
    }
    onOpenChange(next);
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await submit(() => newRecoveryCodes(password, code));
    setPassword('');
    setCode('');
    if (result) setCodes(result.recoveryCodes);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {codes ? (
          <CodesShown
            codes={codes}
            onDone={() => {
              close(false);
            }}
          />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
            <DialogHeader>
              <DialogTitle>New recovery codes</DialogTitle>
              <DialogDescription>
                Ten new codes replace the ones you have, and you are signed out everywhere else.
              </DialogDescription>
            </DialogHeader>
            <ChangeProblem problem={problem} />
            <PasswordAndCode
              password={password}
              code={code}
              onPassword={setPassword}
              onCode={setCode}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  close(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Making codes…' : 'Make new codes'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type PhoneMove =
  | { step: 'check' }
  | { step: 'scan'; secret: string; uri: string }
  | { step: 'codes'; codes: string[] };

function NewPhoneDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [move, setMove] = useState<PhoneMove>({ step: 'check' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();

  function close(next: boolean) {
    if (!next) {
      setMove({ step: 'check' });
      setPassword('');
      setCode('');
      setProblem(undefined);
    }
    onOpenChange(next);
  }

  async function handleCheck(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await submit(() => startPhoneMove(password, code));
    setPassword('');
    setCode('');
    if (result) setMove({ step: 'scan', ...result });
  }

  async function handleConfirm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await submit(() => confirmPhoneMove(code));
    setCode('');
    if (result) setMove({ step: 'codes', codes: result.recoveryCodes });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[520px]">
        {move.step === 'codes' ? (
          <CodesShown
            codes={move.codes}
            onDone={() => {
              close(false);
            }}
          />
        ) : move.step === 'scan' ? (
          <form className="flex flex-col gap-4" onSubmit={(event) => void handleConfirm(event)}>
            <DialogHeader>
              <DialogTitle>Scan with your new phone</DialogTitle>
              <DialogDescription>
                Your current phone keeps working until you enter a code from the new one.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <QrCode value={move.uri} label="QR code for your new phone" />
              <SecretText secret={move.secret} />
            </div>
            {problem?.code === 'invalid_code' ? (
              <Alert variant="destructive">{INVALID_CODE_MESSAGE}</Alert>
            ) : problem ? (
              <ProblemAlert problem={problem} />
            ) : null}
            <Field label="Code from your new phone">
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
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  close(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Verifying…' : 'Use the new phone'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void handleCheck(event)}>
            <DialogHeader>
              <DialogTitle>Move to a new phone</DialogTitle>
              <DialogDescription>
                Confirm it is you with your password and a code from your current phone. You get new
                recovery codes, and you are signed out everywhere else.
              </DialogDescription>
            </DialogHeader>
            <ChangeProblem problem={problem} />
            <PasswordAndCode
              password={password}
              code={code}
              onPassword={setPassword}
              onCode={setCode}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  close(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Checking…' : 'Continue'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
