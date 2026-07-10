"use client";

import { IconX } from "@/components/shared/icons";

interface DeleteConfirmProps {
  /** @param onConfirm - Permanently delete the task. */
  onConfirm: () => void;
  /** @param onCancel - Dismiss the confirmation. */
  onCancel: () => void;
  /** @param autoFocus - Focus the Delete button on mount so a keyboard-armed confirm is reachable. */
  autoFocus?: boolean;
}

/**
 * Two-step delete confirm rendered inline in a row's trailing slot.
 *
 * @param props - Delete handlers and optional mount focus.
 * @returns Pair of mono buttons.
 */
export function DeleteConfirm({
  onConfirm,
  onCancel,
  autoFocus = false,
}: DeleteConfirmProps) {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        autoFocus={autoFocus}
        onClick={(e) => {
          e.stopPropagation();
          onConfirm();
        }}
        className="cursor-pointer rounded px-1.5 py-px font-mono text-[10px] font-semibold text-danger hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/40"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        className="cursor-pointer rounded p-1 text-text-muted hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        aria-label="Cancel delete"
      >
        <IconX size={10} />
      </button>
    </span>
  );
}
