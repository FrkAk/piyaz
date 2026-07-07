/**
 * Shared text-operation engine for operation-based editors. Folds
 * `str_replace`/`append`/`set` ops into a single text value with one set
 * of semantics and error copy across entities (task text fields in
 * `lib/data/task-edit.ts`, note bodies in `lib/data/note.ts`), so the
 * executors cannot drift. No DB access — unit-testable in isolation.
 */

/** Thrown when a `str_replace` `oldStr` matches zero places in the field. */
export class StrReplaceNoMatchError extends Error {
  /**
   * @param field - The text field searched.
   */
  constructor(public readonly field: string) {
    super(`str_replace matched 0 places in ${field}`);
    this.name = "StrReplaceNoMatchError";
  }
}

/** Thrown when a `str_replace` `oldStr` matches more than one place. */
export class StrReplaceMultipleMatchError extends Error {
  /**
   * @param field - The text field searched.
   * @param count - Number of matches found.
   */
  constructor(
    public readonly field: string,
    public readonly count: number,
  ) {
    super(`str_replace matched ${count} places in ${field}`);
    this.name = "StrReplaceMultipleMatchError";
  }
}

/** A `str_replace`/`append`/`set` op against one named text field. */
export type TextOp =
  | { t: "str_replace"; field: string; oldStr: string; newStr: string }
  | { t: "append"; field: string; text: string }
  | { t: "set"; field: string; value: string | null };

/**
 * Compute the new text value for a `str_replace` op.
 *
 * @param current - The field's current text.
 * @param op - The `str_replace` arguments; `field` names the error.
 * @returns The replaced text.
 * @throws StrReplaceNoMatchError when `oldStr` matches zero places.
 * @throws StrReplaceMultipleMatchError when `oldStr` matches more than once.
 */
export function replaceOnce(
  current: string,
  op: { field: string; oldStr: string; newStr: string },
): string {
  const parts = current.split(op.oldStr);
  const count = parts.length - 1;
  if (count === 0) throw new StrReplaceNoMatchError(op.field);
  if (count >= 2) throw new StrReplaceMultipleMatchError(op.field, count);
  return parts.join(op.newStr);
}

/**
 * Fold one text op into the running value. `str_replace` requires exactly
 * one match, `append` joins with a blank line, `set` replaces wholesale.
 *
 * @param current - The running text value (`null` = unset).
 * @param op - The op to fold.
 * @returns The new text value.
 * @throws StrReplaceNoMatchError when `oldStr` matches zero places.
 * @throws StrReplaceMultipleMatchError when `oldStr` matches more than once.
 */
export function foldTextOp(current: string | null, op: TextOp): string | null {
  if (op.t === "str_replace") return replaceOnce(current ?? "", op);
  if (op.t === "append") return current ? `${current}\n\n${op.text}` : op.text;
  return op.value;
}
