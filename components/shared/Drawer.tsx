"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef, type ReactNode } from "react";
import { useModalChrome } from "@/hooks/useModalChrome";

interface DrawerProps {
  /** Whether the drawer is open. */
  open: boolean;
  /** Close the drawer (backdrop click, Esc via the modal stack). */
  onClose: () => void;
  /** Edge the panel slides in from. */
  side: "left" | "right";
  /** CSS width of the panel (e.g. `"300px"`, `"var(--rail-w)"`). */
  width: string;
  /** Accessible label for the dialog. */
  label: string;
  /** Adds `aria-modal="true"` for a true modal drawer. */
  modal?: boolean;
  /** Anchor to the top of the viewport instead of below the top bar. */
  fullHeight?: boolean;
  /** Extra classes appended to the panel (background, etc.). */
  panelClassName?: string;
  /** Class on the static wrapper (e.g. `"lg:hidden"` to gate by breakpoint). */
  wrapperClassName?: string;
  /** Drawer body. */
  children: ReactNode;
}

/**
 * Shared overlay slide-over drawer. Owns the backdrop fade, the edge slide,
 * and the dialog chrome (Escape via the shared modal stack, Tab focus trap,
 * focus seed and restore) from {@link useModalChrome}; reduced motion comes
 * from the global `MotionConfig`. Callers supply the body and any header.
 *
 * @param props - Drawer configuration.
 * @returns Backdrop + sliding panel.
 */
export function Drawer({
  open,
  onClose,
  side,
  width,
  label,
  modal,
  fullHeight,
  panelClassName,
  wrapperClassName,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useModalChrome(open, onClose, panelRef);

  const offscreen = side === "left" ? "-100%" : "100%";
  const edge = side === "left" ? "left-0 border-r" : "right-0 border-l";
  const vertical = fullHeight
    ? "top-0 h-[var(--viewport-height)]"
    : "top-[var(--topbar-h)] h-[calc(var(--viewport-height)-var(--topbar-h))]";

  return (
    <div className={wrapperClassName}>
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
              initial={{ x: offscreen }}
              animate={{ x: 0 }}
              exit={{ x: offscreen }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className={`fixed z-50 flex max-w-[85vw] flex-col border-border shadow-[var(--shadow-float)] ${edge} ${vertical} ${panelClassName ?? ""}`}
              style={{ width }}
              role="dialog"
              aria-modal={modal ? true : undefined}
              aria-label={label}
            >
              {children}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export default Drawer;
