"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef } from "react";
import { useModalChrome } from "@/hooks/useModalChrome";
import { IconX } from "@/components/shared/icons";

interface PropRailDrawerProps {
  /** Whether the drawer is open. */
  open: boolean;
  /** Close the drawer. */
  onClose: () => void;
  /** Drawer body — typically a `<PropRail />`. */
  children: React.ReactNode;
}

/**
 * Slide-out drawer wrapping the property rail for viewports below 1280px.
 * Closes on backdrop click and on Esc. Dialog chrome (Escape via the
 * shared modal stack, Tab focus trap, focus seed and restore) comes from
 * {@link useModalChrome}; the detail-header Esc yields to the stack via
 * `isModalOpen`, so drawer-Escape never deselects the task behind it.
 *
 * @param props - Drawer configuration.
 * @returns Backdrop + sliding panel.
 */
export function PropRailDrawer({
  open,
  onClose,
  children,
}: PropRailDrawerProps) {
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
            className="fixed inset-0 z-40 bg-black/45"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            key="panel"
            ref={panelRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed right-0 top-[var(--topbar-h)] z-50 flex h-[calc(var(--viewport-height)-var(--topbar-h))] max-w-[85vw] flex-col border-l border-border bg-base shadow-[var(--shadow-float)]"
            style={{ width: "var(--rail-w)" }}
            role="dialog"
            aria-label="Task properties"
          >
            <div className="flex h-9 items-center justify-between border-b border-border px-3">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                Properties
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close properties"
                className="cursor-pointer rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-secondary"
              >
                <IconX size={11} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export default PropRailDrawer;
