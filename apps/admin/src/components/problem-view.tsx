import { Navigate, useLocation, type ErrorComponentProps } from '@tanstack/react-router';
import { isApiProblem, SERVER_ERROR_TITLE, type ApiProblem } from '../lib/api.js';
import { sessionWasActive } from '../lib/session.js';
import { ErrorState, NoAccess } from './states.js';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';

/**
 * A refused change, inline in a form or dialog: the API's title, field errors for
 * validation_failed, and the request id. A 5xx shows the fixed message, never server detail.
 */
export function ProblemAlert({ problem }: { problem: ApiProblem }) {
  const title = problem.status >= 500 ? SERVER_ERROR_TITLE : problem.title;
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      {problem.code === 'validation_failed' && problem.errors.length > 0 ? (
        <AlertDescription>
          <ul className="m-0 list-disc pl-5">
            {problem.errors.map((error) => (
              <li key={`${error.path}:${error.message}`}>
                {error.path ? `${error.path}: ` : ''}
                {error.message}
              </li>
            ))}
          </ul>
        </AlertDescription>
      ) : null}
      {problem.requestId ? (
        <AlertDescription className="text-xs opacity-80">
          Reference: {problem.requestId}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

/** Any error a screen can end in, branched on the problem's status and code. */
export function ErrorView({ error, what }: { error: unknown; what?: string }) {
  const location = useLocation();
  if (isApiProblem(error)) {
    if (error.status === 401) {
      // The session ended after the guard ran. Once the move to sign-in has begun, render
      // nothing, or the next render would send the admin to sign-in from sign-in.
      if (location.pathname === '/sign-in') return null;
      return (
        <Navigate
          to="/sign-in"
          search={{
            redirect: location.href,
            ...(sessionWasActive() ? { reason: 'session_ended' as const } : {}),
          }}
          replace
        />
      );
    }
    if (error.code === 'permission_denied') return <NoAccess />;
    return <ErrorState problem={error} {...(what ? { what } : {})} />;
  }
  // A fault in the app itself: say so without echoing the exception.
  return <ErrorState {...(what ? { what } : {})} />;
}

export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div className="flex w-full max-w-[1400px] flex-col gap-5 px-6 pt-5 pb-12 xl:px-8">
      <ErrorView error={error} />
    </div>
  );
}
