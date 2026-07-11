"use client";

import { ModalShell } from "@/components/shared/ModalShell";

interface ConfirmDialogProps {
  /** @param open - Whether the dialog is open. */
  open: boolean;
  /** @param title - Dialog heading. */
  title: string;
  /** @param body - Explanatory copy under the heading. */
  body: React.ReactNode;
  /** @param confirmLabel - Confirm button text. */
  confirmLabel: string;
  /** @param tone - Confirm button tone: `danger` (default) for destructive actions, `neutral` for reversible ones. */
  tone?: "danger" | "neutral";
  /** @param onConfirm - Called when the user confirms the action. */
  onConfirm: () => void;
  /** @param onCancel - Dismiss without confirming (backdrop, Escape, Cancel). */
  onCancel: () => void;
}

/**
 * Centered confirm dialog, built on {@link ModalShell} for its backdrop,
 * motion, and modal chrome (Escape, Tab focus trap, focus seed and
 * restore). Cancel is the first focusable, so the shell seeds focus there
 * and a stray Enter never confirms. Backdrop click and Cancel dismiss
 * without confirming. The confirm button is danger-red by default;
 * `tone="neutral"` renders it accent for reversible actions.
 *
 * @param props - Open flag, copy, tone, and confirm/cancel wiring.
 * @returns Backdrop + centered panel, or nothing while closed.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      role="alertdialog"
      ariaLabel={title}
      panelClassName="w-full max-w-[360px] rounded-xl border border-border p-5 shadow-[var(--shadow-float)]"
    >
      <h2
        className="text-[14px] font-semibold"
        style={{ color: "var(--color-text-primary)" }}
      >
        {title}
      </h2>
      <div className="mt-2 text-[12.5px] leading-relaxed text-text-secondary">
        {body}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-[12px] font-medium text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-[12px] font-semibold text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          style={{
            background:
              tone === "danger"
                ? "var(--color-danger-fill)"
                : "var(--color-accent-fill)",
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
