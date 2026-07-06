"use client";

import { useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useModalChrome } from "@/hooks/useModalChrome";

interface ModalShellProps {
  /** @param open - Whether the dialog is open. */
  open: boolean;
  /** @param onClose - Dismiss without confirming (backdrop, Escape). */
  onClose: () => void;
  /** @param role - ARIA role: `dialog` or `alertdialog` for destructive prompts. */
  role: "dialog" | "alertdialog";
  /** @param ariaLabel - Accessible name when no visible heading is referenced. */
  ariaLabel?: string;
  /** @param panelClassName - Layout/appearance classes for the centered panel. */
  panelClassName: string;
  /** @param children - Panel content (heading, body, actions). */
  children: React.ReactNode;
}

/** Panel surface background shared by dialogs built on this shell. */
const PANEL_STYLE = { background: "var(--color-surface)" } as const;

/**
 * Shared modal scaffold: the dimmed backdrop, centered motion panel, and
 * {@link useModalChrome} wiring (Escape via the modal stack, Tab focus trap,
 * focus seed and restore) that borderless dialogs compose. Backdrop click and
 * Escape call `onClose`; the entrance is disabled under a reduced-motion
 * preference by the global `MotionConfig`.
 *
 * @param props - Open flag, role/label, panel classes, and content.
 * @returns Backdrop + centered panel, or nothing while closed.
 */
export function ModalShell({
  open,
  onClose,
  role,
  ariaLabel,
  panelClassName,
  children,
}: ModalShellProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useModalChrome(open, onClose, panelRef);

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
            onClick={onClose}
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
              role={role}
              aria-modal="true"
              aria-label={ariaLabel}
              className={panelClassName}
              style={PANEL_STYLE}
            >
              {children}
            </motion.aside>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

export default ModalShell;
