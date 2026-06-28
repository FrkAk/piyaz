"use client";

import { useRef } from "react";
import type {
  FocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  caretOffsetFromPoint,
  EDIT_HINT_LABEL,
  placeCaret,
} from "@/components/shared/inlineEdit";

/** Caret placement when entering edit mode. */
type CaretMode = "point" | "end";

/** Props spread onto the display element to make it an inline-edit trigger. */
interface InlineEditTriggerProps {
  tabIndex: number;
  title: string;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

interface InlineEditHandlers {
  /** Spread on the display element: double-click (mouse) or Enter/Space (keyboard) enters edit mode. */
  triggerProps: InlineEditTriggerProps;
  /** Bind to the touch-only edit button's `onClick`; focuses the editor at the end. */
  onActivate: () => void;
  /** Bind to the editor's `onFocus` to position the caret. */
  onEditorFocus: (
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
}

/**
 * Wire double-click and keyboard activation to edit, with caret positioning, for an inline field.
 * @param startEditing - Enters edit mode (sets the field's local editing state).
 * @param caret - `"point"` places the caret at the double-clicked character, for plain-text fields whose rendered text mirrors the editable value; `"end"` focuses at the end, for markdown fields and any activation that carries no pointer coordinate (keyboard, touch button).
 * @returns Trigger props for the display element, the touch-button activate handler, and the editor focus handler.
 */
export function useInlineEdit(
  startEditing: () => void,
  caret: CaretMode = "end",
): InlineEditHandlers {
  const pendingCaret = useRef<number | null>(null);

  return {
    triggerProps: {
      tabIndex: 0,
      title: EDIT_HINT_LABEL,
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
      onKeyDown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        pendingCaret.current = null;
        startEditing();
      },
    },
    onActivate: () => {
      pendingCaret.current = null;
      startEditing();
    },
    onEditorFocus: (event) => {
      placeCaret(event.currentTarget, pendingCaret.current);
      pendingCaret.current = null;
    },
  };
}
