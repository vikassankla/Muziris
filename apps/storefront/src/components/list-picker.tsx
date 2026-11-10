import { NEW_LIST } from '../lib/shopping-lists.js';
import { Input, Select } from './ui/input.js';
import { Label } from './ui/label.js';

interface ListPickerProps {
  lists: readonly { id: string; name: string }[];
  target: string;
  onTarget: (target: string) => void;
  newName: string;
  onNewName: (name: string) => void;
  /** The select's label; "Shopping list" unless given. */
  label?: string;
}

/** Picks one of the buyer's lists, or "New list…" with a name field. */
export function ListPicker({
  lists,
  target,
  onTarget,
  newName,
  onNewName,
  label = 'Shopping list',
}: ListPickerProps) {
  return (
    <>
      <div className="flex min-w-[200px] flex-col gap-1.5">
        <Label htmlFor="target-list">{label}</Label>
        <Select
          id="target-list"
          value={target}
          onChange={(event) => {
            onTarget(event.target.value);
          }}
        >
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
          <option value={NEW_LIST}>New list…</option>
        </Select>
      </div>
      {target === NEW_LIST ? (
        <div className="flex min-w-[200px] flex-col gap-1.5">
          <Label htmlFor="new-list-name">List name</Label>
          <Input
            id="new-list-name"
            maxLength={100}
            value={newName}
            onChange={(event) => {
              onNewName(event.target.value);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
