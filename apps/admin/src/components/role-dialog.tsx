import { useState, type SubmitEvent } from 'react';
import { codeFromName } from '../lib/codes.js';
import { CODE_HINT, CODE_PATTERN, fieldErrors } from '../lib/form.js';
import { useSubmit } from '../lib/use-submit.js';
import { Field } from './field.js';
import { ProblemAlert } from './problem-view.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Input, Textarea } from './ui/input.js';

/**
 * New admin role or buyer role: name, code and description. The permissions or grants come
 * from `carried` (empty, or a copy of the role being duplicated) and are edited afterwards.
 */
export function NewRoleDialog<T extends { id: string }>({
  open,
  onOpenChange,
  noun,
  takenCode,
  duplicateOf,
  create,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "admin role" or "buyer role" */
  noun: string;
  /** The API code for a code already in use. */
  takenCode: string;
  duplicateOf?: string | undefined;
  create: (input: { code: string; name: string; description: string }) => Promise<T>;
  onCreated: (role: T) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [description, setDescription] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);
  const shownCode = codeEdited ? code : codeFromName(name);
  const codeError =
    problem?.code === takenCode
      ? `A ${noun} with this code already exists.`
      : shownCode !== '' && !CODE_PATTERN.test(shownCode)
        ? 'Use 2 to 63 lowercase letters, digits or underscores, starting with a letter.'
        : errors['code'];

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const role = await submit(() => create({ code: shownCode, name, description }), {
      title: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} created`,
      description: name,
    });
    if (role) {
      setName('');
      setCode('');
      setCodeEdited(false);
      setDescription('');
      onCreated(role);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{duplicateOf ? `Duplicate ${duplicateOf}` : `New ${noun}`}</DialogTitle>
          <DialogDescription>
            {duplicateOf
              ? `Starts with the same permissions as ${duplicateOf}.`
              : 'Choose its permissions after saving.'}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' && problem.code !== takenCode ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field label="Name" error={errors['name']}>
            {(props) => (
              <Input
                {...props}
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Code" hint={CODE_HINT} error={codeError}>
            {(props) => (
              <Input
                {...props}
                required
                className="font-mono"
                maxLength={63}
                value={shownCode}
                onChange={(e) => {
                  setCodeEdited(true);
                  setCode(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Description" optional error={errors['description']}>
            {(props) => (
              <Textarea
                {...props}
                maxLength={1000}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Create {noun}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
