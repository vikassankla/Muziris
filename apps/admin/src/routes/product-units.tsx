import { createRoute, useNavigate } from '@tanstack/react-router';
import { Info, Plus, Ruler } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { Field } from '../components/field.js';
import { Breadcrumbs, Page, PageHeader } from '../components/page-header.js';
import { ProblemAlert } from '../components/problem-view.js';
import { EmptyState } from '../components/states.js';
import { Alert, AlertTitle } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { createProductUnit, listProductUnits } from '../lib/endpoints.js';
import { formatQuantity } from '../lib/format.js';
import { fieldErrors } from '../lib/form.js';
import { listSearch, withNew, type ListSearch } from '../lib/search.js';
import { can } from '../lib/session.js';
import { useSession } from '../lib/session-context.js';
import { useSubmit } from '../lib/use-submit.js';
import { useWebsite } from '../lib/website.js';
import { authedRoute } from './authed.js';

/** Sample quantities for the "shown as" column, one per precision (ProductUnits board). */
const SAMPLE = ['1250', '2', '15.5', '20'];

export const productUnitsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/product-units',
  validateSearch: listSearch,
  loader: ({ abortController }) => listProductUnits(abortController.signal),
  component: ProductUnitsPage,
});

const UNIT_CODE = /^[a-z][a-z0-9_]{0,31}$/;

function NewProductUnitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [precision, setPrecision] = useState('0');
  const { pending, problem, setProblem, submit } = useSubmit();
  const website = useWebsite();
  const errors = fieldErrors(problem);
  const codeError =
    problem?.code === 'product_unit_code_taken'
      ? 'A product unit with this code already exists.'
      : code !== '' && !UNIT_CODE.test(code)
        ? 'Use 1 to 32 lowercase letters, digits or underscores, starting with a letter.'
        : errors['code'];

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await submit(
      () => createProductUnit({ code, name, precision: Number(precision) }),
      {
        title: 'Product unit created',
        description: name,
      },
    );
    if (created) {
      setCode('');
      setName('');
      setPrecision('0');
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
          <DialogTitle>New product unit</DialogTitle>
          <DialogDescription>The code cannot be changed later.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {problem &&
          problem.code !== 'validation_failed' &&
          problem.code !== 'product_unit_code_taken' ? (
            <ProblemAlert problem={problem} />
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" error={errors['name']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Code" error={codeError}>
              {(props) => (
                <Input
                  {...props}
                  required
                  className="font-mono"
                  maxLength={32}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <Field
            label="Decimal precision"
            hint={`A quantity is shown as ${formatQuantity(SAMPLE[1] ?? '2', { code: code || 'kg', name: name || 'Each', precision: Number(precision) }, website)}.`}
          >
            {({ id }) => (
              <Select value={precision} onValueChange={setPrecision}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['0', '1', '2', '3', '4', '5', '6'].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p === '0'
                        ? '0 (whole numbers)'
                        : `${p} decimal ${p === '1' ? 'place' : 'places'}`}
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
            <Button type="submit" disabled={pending}>
              Create product unit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProductUnitsPage() {
  const units = productUnitsRoute.useLoaderData();
  const search = productUnitsRoute.useSearch();
  const navigate = useNavigate();
  const website = useWebsite();
  const manage = can(useSession(), 'product.manage');
  const setNew = (open: boolean) => {
    void navigate({ to: '.', search: withNew<ListSearch>(open) });
  };
  const newButton = manage ? (
    <Button
      onClick={() => {
        setNew(true);
      }}
    >
      <Plus aria-hidden="true" />
      New product unit
    </Button>
  ) : null;
  return (
    <Page>
      <Breadcrumbs crumbs={[{ label: 'Catalog' }, { label: 'Product units' }]} />
      <PageHeader
        title="Product units"
        description="The units products are sold in, and how many decimal places a quantity may have."
        actions={newButton}
      />
      <Alert variant="info" icon={<Info />}>
        <AlertTitle>Create product units before your first product.</AlertTitle>
        <span className="text-meta">Every product needs a primary product unit.</span>
      </Alert>
      {units.length === 0 ? (
        <EmptyState
          icon={Ruler}
          title="No product units yet"
          description="Start with Each, then add the others you sell in, such as Box or Kilogram."
          action={newButton ?? undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Decimal precision</TableHead>
              <TableHead>A quantity is shown as</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {units.map((unit) => (
              <TableRow key={unit.code}>
                <TableCell className="font-mono text-[12.5px]">{unit.code}</TableCell>
                <TableCell className="font-semibold">{unit.name}</TableCell>
                <TableCell className="num text-right">{unit.precision}</TableCell>
                <TableCell className="num">
                  {formatQuantity(
                    SAMPLE[Math.min(unit.precision, SAMPLE.length - 1)] ?? '1',
                    unit,
                    website,
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="m-0 text-meta text-muted-foreground">
        Quantities always show every decimal place the unit allows: 2 kg with precision 3 is shown
        as{' '}
        <span className="num text-foreground">
          {formatQuantity('2', { code: 'kg', name: 'Kilogram', precision: 3 }, website)}
        </span>
        .
      </p>
      {manage ? <NewProductUnitDialog open={search.new === true} onOpenChange={setNew} /> : null}
    </Page>
  );
}
