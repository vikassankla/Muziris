import { useState, type SubmitEvent } from 'react';
import {
  assignBuyerRole,
  createBuyerUser,
  createInvitation,
  linkBuyerUser,
  type BuyerRole,
} from '../lib/endpoints.js';
import { fieldErrors } from '../lib/form.js';
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
import { Input } from './ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
}

/** Add buyer user: makes a new buyer account for this customer, with or without a password. */
export function AddBuyerUserDialog({ open, onOpenChange, customerId, customerName }: DialogProps) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await submit(
      () => createBuyerUser(customerId, { email, displayName, ...(password ? { password } : {}) }),
      { title: 'Buyer user added', description: `${displayName} · ${customerName}` },
    );
    setPassword('');
    if (created) {
      setEmail('');
      setDisplayName('');
      onOpenChange(false);
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
          <DialogTitle>Add buyer user</DialogTitle>
          <DialogDescription>
            Creates a storefront account for a person at {customerName}.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field label="Name" error={errors['displayName']}>
            {(props) => (
              <Input
                {...props}
                required
                maxLength={200}
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Email" error={errors['email']}>
            {(props) => (
              <Input
                {...props}
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label="Password"
            optional
            hint="12 characters or more. Leave empty and send an invitation instead to let the person choose one."
            error={errors['password']}
          >
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
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
              Add buyer user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Link existing buyer user: an existing buyer account becomes a buyer user of this customer. */
export function LinkBuyerUserDialog({ open, onOpenChange, customerId, customerName }: DialogProps) {
  const [email, setEmail] = useState('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const linked = await submit(() => linkBuyerUser(customerId, email), {
      title: 'Buyer user linked',
      description: `${email} · ${customerName}`,
    });
    if (linked) {
      setEmail('');
      onOpenChange(false);
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
          <DialogTitle>Link existing buyer user</DialogTitle>
          <DialogDescription>For a person who already has a storefront account.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field label="Email of the buyer account" error={errors['email']}>
            {(props) => (
              <Input
                {...props}
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
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
              Link buyer user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Invite a buyer user. The API emails them a link to set a password (ADR 0020); the token is
 * never shown here.
 */
export function InviteDialog({ open, onOpenChange, customerId, customerName }: DialogProps) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [days, setDays] = useState('7');
  const { pending, problem, setProblem, submit } = useSubmit();
  const errors = fieldErrors(problem);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await submit(
      () => createInvitation(customerId, { email, displayName, expiresInHours: Number(days) * 24 }),
      { title: 'Invitation sent', description: `${email} will get an email with a link` },
    );
    if (result) close();
  }

  function close() {
    setEmail('');
    setDisplayName('');
    setProblem(undefined);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a buyer user</DialogTitle>
          <DialogDescription>
            {customerName}. They get an email with a link to choose a password.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem && problem.code !== 'validation_failed' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <Field label="Name" error={errors['displayName']}>
            {(props) => (
              <Input
                {...props}
                required
                maxLength={200}
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Email" error={errors['email']}>
            {(props) => (
              <Input
                {...props}
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label="Expires after"
            hint="Sending a new invitation to the same email revokes the open one."
          >
            {({ id }) => (
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['1', '3', '7', '14', '30'].map((d) => (
                    <SelectItem key={d} value={d}>
                      {d} {d === '1' ? 'day' : 'days'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Give a buyer user a buyer role. The API has no list of a buyer user's roles yet. */
export function AssignBuyerRoleDialog({
  open,
  onOpenChange,
  userId,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  roles: readonly BuyerRole[];
}) {
  const [roleId, setRoleId] = useState<string>('');
  const { pending, problem, setProblem, submit } = useSubmit();
  const role = roles.find((r) => r.id === roleId);

  async function save() {
    if (!role) return;
    const done = await submit(() => assignBuyerRole(userId, role.id).then(() => true), {
      title: 'Buyer role assigned',
      description: role.name,
    });
    if (done) onOpenChange(false);
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
          <DialogTitle>Assign a buyer role</DialogTitle>
          <DialogDescription>Buyer user {userId}</DialogDescription>
        </DialogHeader>
        {problem ? <ProblemAlert problem={problem} /> : null}
        <Field label="Buyer role">
          {({ id }) => (
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id={id}>
                <SelectValue placeholder="Choose a buyer role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          <Button disabled={pending || !role} onClick={() => void save()}>
            Assign buyer role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
