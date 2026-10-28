import { Navigate, useLocation, type ErrorComponentProps } from '@tanstack/react-router';
import { isApiProblem, SERVER_ERROR_TITLE, type ApiProblem } from '../lib/api.js';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';

/** Shown for a 403 permission_denied: the API refused, whatever the navigation showed. */
export function NoAccess() {
  return (
    <Alert>
      <AlertTitle>No access</AlertTitle>
      <AlertDescription>
        Your admin roles do not let you see this. Ask an administrator if you need it.
      </AlertDescription>
    </Alert>
  );
}

/**
 * An API problem as the admin should see it: the title, field errors for validation_failed,
 * and the request id to quote to support. Server details are never shown.
 */
export function ProblemAlert({ problem }: { problem: ApiProblem }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{problem.title}</AlertTitle>
      {problem.code === 'validation_failed' && problem.errors.length > 0 ? (
        <AlertDescription>
          <ul className="list-disc pl-5">
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
        <AlertDescription className="mt-1 text-xs opacity-80">
          Reference: {problem.requestId}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

/** Any error a screen can end in, branched on the problem's code. */
export function ErrorView({ error }: { error: unknown }) {
  const location = useLocation();
  if (isApiProblem(error)) {
    if (error.status === 401) {
      // The session ended after the guard ran. Once the move to sign-in has begun, render
      // nothing, or the next render would send the admin to sign-in from sign-in.
      if (location.pathname === '/sign-in') return null;
      return <Navigate to="/sign-in" search={{ redirect: location.href }} replace />;
    }
    if (error.code === 'permission_denied') return <NoAccess />;
    return <ProblemAlert problem={error} />;
  }
  // A fault in the app itself: say so without echoing the exception.
  return (
    <Alert variant="destructive">
      <AlertTitle>{SERVER_ERROR_TITLE}</AlertTitle>
      <AlertDescription>
        Reload the page. If it happens again, tell your administrator.
      </AlertDescription>
    </Alert>
  );
}

export function RouteError({ error }: ErrorComponentProps) {
  return <ErrorView error={error} />;
}
