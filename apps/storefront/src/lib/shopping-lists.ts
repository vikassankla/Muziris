import { AddShoppingListLines, CreateShoppingList } from '../operations/generated.js';
import { runOperation } from './api.js';
import type { CheckoutLine } from './checkout.js';

/** The list picker's value for "New list…". */
export const NEW_LIST = 'new';

export type AddedToList =
  | { ok: true; listId: string; listName: string }
  /** `lineIndex` is the first refused line, when the refusal names one. */
  | { ok: false; message: string; lineIndex?: number };

/**
 * Adds lines to a list the buyer picked, or to a new list with the name they typed. The API
 * adds nothing when any line has a problem. Network and sign-in errors are thrown.
 */
export async function addToShoppingList(
  target: string,
  newName: string,
  lines: readonly CheckoutLine[],
): Promise<AddedToList> {
  let listId = target;
  if (target === NEW_LIST) {
    const { createShoppingList } = await runOperation(CreateShoppingList, {
      name: newName.trim(),
    });
    if (!createShoppingList.list) {
      return {
        ok: false,
        message: createShoppingList.refusal?.message ?? 'The list was not made.',
      };
    }
    listId = createShoppingList.list.id;
  }
  const { addShoppingListLines } = await runOperation(AddShoppingListLines, {
    listId,
    lines: [...lines],
  });
  if (addShoppingListLines.refusal) {
    const [first] = addShoppingListLines.refusal.lines;
    return first === undefined
      ? { ok: false, message: addShoppingListLines.refusal.message }
      : { ok: false, message: first.message, lineIndex: first.index };
  }
  return {
    ok: true,
    listId,
    listName: addShoppingListLines.list?.name ?? newName.trim(),
  };
}
