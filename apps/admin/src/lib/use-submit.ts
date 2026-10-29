import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiProblem, isApiProblem, SERVER_ERROR_TITLE } from './api.js';

/**
 * Runs a change against the API for a form or dialog: tracks pending, keeps the refusal as a
 * problem to show next to the fields, and on success reloads the screen's data and shows a
 * toast. Anything that is not an API answer becomes the generic server message.
 */
export function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  async function submit<T>(
    action: () => Promise<T>,
    success?: { title: string; description?: string },
  ): Promise<T | undefined> {
    setPending(true);
    setProblem(undefined);
    try {
      const result = await action();
      if (success)
        toast.success(
          success.title,
          success.description ? { description: success.description } : {},
        );
      await router.invalidate();
      return result;
    } catch (error) {
      setProblem(
        isApiProblem(error)
          ? error
          : new ApiProblem({ status: 0, code: 'unexpected_error', title: SERVER_ERROR_TITLE }),
      );
      return undefined;
    } finally {
      setPending(false);
    }
  }

  return { pending, problem, setProblem, submit };
}
