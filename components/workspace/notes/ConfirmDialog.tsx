"use client";

import { useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useModalChrome } from "@/hooks/useModalChrome";

interface ConfirmDialogProps {
  /** @param open - Whether the dialog is open. */
  open: boolean;
  /** @param title - Dialog heading. */
  title: string;
  /** @param body - Explanatory copy under the heading. */
  body: React.ReactNode;
  /** @param confirmLabel - Confirm button text. */
  confirmLabel: string;
  /** @param onConfirm - Called when the user confirms the action. */
  onConfirm: () => void;
  /** @param onCancel - Dismiss without confirming (backdrop, Escape, Cancel). */
  onCancel: () => void;
}

/**
 * Centered confirm dialog for a destructive action. Dialog chrome (Escape
 * via the shared modal stack, Tab focus trap, focus seed and restore)
 * comes from {@link useModalChrome}, which seeds focus on the Cancel
 * button so a stray Enter never confirms; the global `MotionConfig`
 * disables the entrance under a reduced-motion preference. Backdrop click
 * and Cancel dismiss without confirming.
 *
 * @param props - Open flag, copy, and confirm/cancel wiring.
 * @returns Backdrop + centered panel, or nothing while closed.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useModalChrome(open, onCancel, panelRef);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[60] bg-black/45"
            onClick={onCancel}
            aria-hidden="true"
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <motion.aside
              key="panel"
              ref={panelRef}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              role="alertdialog"
              aria-modal="true"
              aria-label={title}
              className="w-full max-w-[360px] rounded-xl border border-border p-5 shadow-[var(--shadow-float)]"
              style={{ background: "var(--color-surface)" }}
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
                  style={{ background: "var(--color-danger)" }}
                >
                  {confirmLabel}
                </button>
              </div>
            </motion.aside>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
