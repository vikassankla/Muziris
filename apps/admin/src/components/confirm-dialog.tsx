import { useState, type ReactNode } from 'react';
import { isApiProblem, type ApiProblem } from '../lib/api.js';
import { ProblemAlert } from './problem-view.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from './ui/alert-dialog.js';
import { Button } from './ui/button.js';

/**
 * Confirm before a destructive change (States board). The dialog stays open on a refusal and
 * shows why, for example category_not_empty or last_administrator.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        {problem ? <ProblemAlert problem={problem} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setProblem(undefined);
              onConfirm()
                .then(() => {
                  onOpenChange(false);
                })
                .catch((error: unknown) => {
                  if (isApiProblem(error)) setProblem(error);
                  else throw error;
                })
                .finally(() => {
                  setPending(false);
                });
            }}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
