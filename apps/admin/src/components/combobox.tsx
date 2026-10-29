import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Shown after the label, smaller: a code, a path. */
  hint?: string;
}

/** shadcn/ui Combobox (Popover and Command): a searchable picker for categories, customers. */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  emptyLabel,
  searchLabel,
  invalid,
  describedBy,
  disabled = false,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: readonly ComboboxOption[];
  placeholder: string;
  /** When set, a first option that clears the value, such as "None (top-level customer)". */
  emptyLabel?: string;
  searchLabel: string;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const shown = selected?.label ?? (value === null && emptyLabel ? emptyLabel : placeholder);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={disabled}
          className={cn(
            'flex h-control w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-control disabled:opacity-50 aria-invalid:border-destructive',
            !selected && !(value === null && emptyLabel) && 'text-muted-foreground',
          )}
        >
          <span className="truncate">{shown}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0">
        <Command>
          <CommandInput placeholder={searchLabel} aria-label={searchLabel} />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {emptyLabel ? (
                <CommandItem
                  value={`__none ${emptyLabel}`}
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="h-8"
                >
                  <Check
                    className={cn(value === null ? 'opacity-100' : 'opacity-0')}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">{emptyLabel}</span>
                </CommandItem>
              ) : null}
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.hint ?? ''} ${option.value}`}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="h-8"
                >
                  <Check
                    className={cn(option.value === value ? 'opacity-100' : 'opacity-0')}
                    aria-hidden="true"
                  />
                  <span className="truncate">{option.label}</span>
                  {option.hint ? (
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {option.hint}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
