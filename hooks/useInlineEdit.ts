"use client";

import { useRef } from "react";
import type { FocusEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  caretOffsetFromPoint,
  placeCaret,
} from "@/components/shared/inlineEdit";

/** Caret placement when entering edit mode. */
type CaretMode = "point" | "end";

interface InlineEditHandlers {
  /** Bind to the display element's `onDoubleClick` to enter edit mode. */
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Bind to the editor's `onFocus` to position the caret. */
  onEditorFocus: (
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
}

/**
 * Wire double-click-to-edit with caret positioning for an inline field.
 * @param startEditing - Enters edit mode (sets the field's local editing state).
 * @param caret - `"point"` places the caret at the double-clicked character, for plain-text fields whose rendered text mirrors the editable value; `"end"` focuses at the end, for markdown fields and any keyboard activation that carries no pointer coordinate.
 * @returns Handlers for the display element and the editor.
 */
export function useInlineEdit(
  startEditing: () => void,
  caret: CaretMode = "end",
): InlineEditHandlers {
  const pendingCaret = useRef<number | null>(null);

  return {
    onDoubleClick: (event) => {
      pendingCaret.current =
        caret === "point"
          ? caretOffsetFromPoint(
              event.currentTarget,
              event.clientX,
              event.clientY,
            )
          : null;
      startEditing();
    },
    onEditorFocus: (event) => {
      placeCaret(event.currentTarget, pendingCaret.current);
      pendingCaret.current = null;
    },
  };
}
