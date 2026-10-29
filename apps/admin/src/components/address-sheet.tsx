import { Info } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import {
  GST_STATE_CODES,
  gstinMessage,
  isPinCode,
  isZipCode,
  US_STATES,
} from '../lib/address-rules.js';
import { addAddress, type NewAddress } from '../lib/endpoints.js';
import { fieldErrors } from '../lib/form.js';
import { useSubmit } from '../lib/use-submit.js';
import { Field } from './field.js';
import { ProblemAlert } from './problem-view.js';
import { Alert } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui/sheet.js';

type Country = 'IN' | 'US';

function blank(countryCode: Country): NewAddress {
  return {
    countryCode,
    label: '',
    line1: '',
    line2: '',
    city: '',
    regionCode: '',
    postalCode: '',
    gstin: null,
    isDefaultBilling: false,
    isDefaultShipping: false,
  };
}

/** Errors the form can see before asking the API: PIN, ZIP, GSTIN and a missing state. */
export function validateAddress(address: NewAddress): Record<string, string> {
  const errors: Record<string, string> = {};
  if (address.regionCode === '') errors['regionCode'] = 'Choose a state.';
  if (address.countryCode === 'IN') {
    if (!isPinCode(address.postalCode))
      errors['postalCode'] = 'Enter a 6-digit PIN code, such as 410501.';
    if (address.gstin) {
      const message = gstinMessage(address.gstin, address.regionCode);
      if (message) errors['gstin'] = message;
    }
  } else if (!isZipCode(address.postalCode)) {
    errors['postalCode'] = 'Enter a 5-digit ZIP code (77029) or ZIP+4 (77029-1234).';
  }
  return errors;
}

/**
 * Add an address to a customer (AddressForms board). The fields follow the country: PIN code,
 * GST state code and GSTIN for India; state and ZIP code for the US.
 */
export function AddressSheet({
  open,
  onOpenChange,
  customerId,
  customerName,
  defaultCountry,
  currentDefaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  defaultCountry: Country;
  currentDefaults: { billing?: string | undefined; shipping?: string | undefined };
}) {
  const [address, setAddress] = useState<NewAddress>(() => blank(defaultCountry));
  const [checked, setChecked] = useState(false);
  const { pending, problem, setProblem, submit } = useSubmit();
  const local = checked ? validateAddress(address) : {};
  const errors = { ...fieldErrors(problem), ...local };
  const india = address.countryCode === 'IN';
  const set = (changes: Partial<NewAddress>) => {
    setAddress((a) => ({ ...a, ...changes }));
  };

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecked(true);
    if (Object.keys(validateAddress(address)).length > 0) return;
    const saved = await submit(
      () =>
        addAddress(customerId, {
          ...address,
          gstin: india && address.gstin ? address.gstin.trim().toUpperCase() : null,
        }),
      { title: 'Address saved', description: address.label },
    );
    if (saved) {
      setAddress(blank(defaultCountry));
      setChecked(false);
      onOpenChange(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setProblem(undefined);
          setChecked(false);
        }
        onOpenChange(next);
      }}
    >
      <SheetContent lang={india ? 'en-IN' : 'en-US'}>
        <SheetHeader>
          <SheetTitle>Add address</SheetTitle>
          <SheetDescription>{customerName}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          <SheetBody className="grid grid-cols-2 content-start gap-4">
            {problem && problem.code !== 'validation_failed' ? (
              <div className="col-span-2">
                <ProblemAlert problem={problem} />
              </div>
            ) : null}
            <Field label="Country" className="col-span-2">
              {({ id }) => (
                <Select
                  value={address.countryCode}
                  onValueChange={(value) => {
                    set({
                      countryCode: value as Country,
                      regionCode: '',
                      postalCode: '',
                      gstin: null,
                    });
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IN">India</SelectItem>
                    <SelectItem value="US">United States</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field
              label="Label"
              className="col-span-2"
              hint="Shown to buyers when they pick an address."
              error={errors['label']}
            >
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={100}
                  value={address.label}
                  onChange={(e) => {
                    set({ label: e.target.value });
                  }}
                />
              )}
            </Field>
            <Field label="Street address" className="col-span-2" error={errors['line1']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={200}
                  autoComplete="address-line1"
                  value={address.line1}
                  onChange={(e) => {
                    set({ line1: e.target.value });
                  }}
                />
              )}
            </Field>
            <Field
              label="Street address line 2"
              optional
              className="col-span-2"
              error={errors['line2']}
            >
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  autoComplete="address-line2"
                  value={address.line2}
                  onChange={(e) => {
                    set({ line2: e.target.value });
                  }}
                />
              )}
            </Field>
            <Field label="City" error={errors['city']}>
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={100}
                  value={address.city}
                  onChange={(e) => {
                    set({ city: e.target.value });
                  }}
                />
              )}
            </Field>
            {india ? (
              <Field label="PIN code" hint="6 digits" error={errors['postalCode']}>
                {(props) => (
                  <Input
                    {...props}
                    className="num"
                    inputMode="numeric"
                    maxLength={7}
                    autoComplete="postal-code"
                    value={address.postalCode}
                    onChange={(e) => {
                      set({ postalCode: e.target.value });
                    }}
                  />
                )}
              </Field>
            ) : (
              <Field label="State" error={errors['regionCode']}>
                {(props) => (
                  <Select
                    value={address.regionCode}
                    onValueChange={(value) => {
                      set({ regionCode: value });
                    }}
                  >
                    <SelectTrigger
                      id={props.id}
                      aria-invalid={props['aria-invalid']}
                      aria-describedby={props['aria-describedby']}
                    >
                      <SelectValue placeholder="Choose a state" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(US_STATES).map(([code, name]) => (
                        <SelectItem key={code} value={code}>
                          {name} ({code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
            {india ? (
              <>
                <Field
                  label="State"
                  className="col-span-2"
                  hint="GST state code. Decides CGST and SGST, or IGST, on orders."
                  error={errors['regionCode']}
                >
                  {(props) => (
                    <Select
                      value={address.regionCode}
                      onValueChange={(value) => {
                        set({ regionCode: value });
                      }}
                    >
                      <SelectTrigger
                        id={props.id}
                        aria-invalid={props['aria-invalid']}
                        aria-describedby={props['aria-describedby']}
                      >
                        <SelectValue placeholder="Choose a state" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(GST_STATE_CODES).map(([code, name]) => (
                          <SelectItem key={code} value={code}>
                            <span className="font-mono text-muted-foreground">{code}</span> · {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
                <Field
                  label="GSTIN"
                  optional
                  className="col-span-2"
                  hint="15 characters: state code, PAN, entity number, Z, check character."
                  error={errors['gstin']}
                >
                  {(props) => (
                    <Input
                      {...props}
                      className="font-mono tracking-[0.06em] uppercase"
                      maxLength={15}
                      value={address.gstin ?? ''}
                      onChange={(e) => {
                        set({ gstin: e.target.value === '' ? null : e.target.value });
                      }}
                    />
                  )}
                </Field>
              </>
            ) : (
              <>
                <Field label="ZIP code" className="col-span-2" error={errors['postalCode']}>
                  {(props) => (
                    <Input
                      {...props}
                      className="num max-w-[200px]"
                      maxLength={10}
                      autoComplete="postal-code"
                      value={address.postalCode}
                      onChange={(e) => {
                        set({ postalCode: e.target.value });
                      }}
                    />
                  )}
                </Field>
                <Alert variant="info" icon={<Info />} className="col-span-2">
                  <span className="text-meta">
                    Sales tax on orders shipped here will use the rate for this state and ZIP code.
                  </span>
                </Alert>
              </>
            )}
            <fieldset className="col-span-2 m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="mb-2 text-[13px] font-[550]">Defaults</legend>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="default-billing"
                  checked={address.isDefaultBilling}
                  onCheckedChange={(value) => {
                    set({ isDefaultBilling: value === true });
                  }}
                />
                <Label htmlFor="default-billing" className="font-normal">
                  Default billing address
                  {address.isDefaultBilling && currentDefaults.billing ? (
                    <span className="text-xs text-muted-foreground">
                      {' '}
                      (replaces {currentDefaults.billing})
                    </span>
                  ) : null}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="default-shipping"
                  checked={address.isDefaultShipping}
                  onCheckedChange={(value) => {
                    set({ isDefaultShipping: value === true });
                  }}
                />
                <Label htmlFor="default-shipping" className="font-normal">
                  Default shipping address
                  {address.isDefaultShipping && currentDefaults.shipping ? (
                    <span className="text-xs text-muted-foreground">
                      {' '}
                      (replaces {currentDefaults.shipping})
                    </span>
                  ) : null}
                </Label>
              </div>
            </fieldset>
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button type="submit" disabled={pending}>
              Save address
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
