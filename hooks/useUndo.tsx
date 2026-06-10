"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { IconUndo } from "@/components/shared/icons";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseUndoOptions<T> {
  /**
   * @param onUndo - Called with the popped item when undo is triggered. May
   *   return a promise; if it rejects, the item is pushed back onto the stack
   *   so a failed undo (e.g. a rate-limited or rejected server write) does not
   *   silently discard the entry and lose the user's only recovery path.
   */
  onUndo: (item: T) => void | Promise<void>;
  /** @param resetOn - Auto-clear the stack when this value changes. */
  resetOn?: unknown;
  /** @param keyboard - Enable Ctrl+Z / Cmd+Z. Pass object with panelSelector for focus-scoping. */
  keyboard?: boolean | { panelSelector?: string };
}

/**
 * Generic stack-based undo hook with optional Ctrl+Z keyboard support.
 * @param opts - Configuration: onUndo callback, resetOn dependency, keyboard toggle.
 * @returns canUndo flag, push function, and undo trigger.
 */
export function useUndo<T>(opts: UseUndoOptions<T>): {
  canUndo: boolean;
  push: (item: T) => void;
  undo: () => void;
} {
  const [stack, setStack] = useState<T[]>([]);
  const stackRef = useRef(stack);
  const onUndoRef = useRef(opts.onUndo);

  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  useEffect(() => {
    onUndoRef.current = opts.onUndo;
  }, [opts.onUndo]);

  const canUndo = stack.length > 0;

  const push = useCallback((item: T) => {
    setStack((prev) => [...prev, item]);
  }, []);

  const undo = useCallback(() => {
    const current = stackRef.current;
    if (current.length === 0) return;
    const last = current[current.length - 1];
    setStack(current.slice(0, -1));
    Promise.resolve(onUndoRef.current(last)).catch(() => {
      setStack((prev) => [...prev, last]);
    });
  }, []);

  // Auto-clear on resetOn change
  const [prevResetOn, setPrevResetOn] = useState(opts.resetOn);
  if (opts.resetOn !== prevResetOn) {
    setPrevResetOn(opts.resetOn);
    setStack([]);
  }

  // Ctrl+Z / Cmd+Z keyboard shortcut
  useEffect(() => {
    if (!opts.keyboard || !canUndo) return;

    const panelSelector =
      typeof opts.keyboard === "object"
        ? opts.keyboard.panelSelector
        : undefined;

    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (panelSelector && !(e.target as HTMLElement)?.closest(panelSelector))
          return;
        e.preventDefault();
        undo();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [opts.keyboard, canUndo, undo]);

  return { canUndo, push, undo };
}

// ---------------------------------------------------------------------------
// UndoButton component
// ---------------------------------------------------------------------------

interface UndoButtonProps {
  /** @param canUndo - Whether the button should be visible. */
  canUndo: boolean;
  /** @param onUndo - Called when the button is clicked. */
  onUndo: () => void;
  /** @param className - Additional CSS classes on the wrapper. */
  className?: string;
}

/**
 * Animated undo button with consistent styling across the app.
 * @param props - Visibility flag, click handler, optional className.
 * @returns AnimatePresence-wrapped motion button, or nothing when canUndo is false.
 */
export function UndoButton({
  canUndo,
  onUndo,
  className = "",
}: UndoButtonProps) {
  return (
    <AnimatePresence>
      {canUndo && (
        <motion.button
          type="button"
          initial={{ opacity: 0, x: 4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 4 }}
          transition={{ duration: 0.12 }}
          onClick={onUndo}
          className={`inline-flex h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text-secondary ${className}`}
        >
          <IconUndo size={11} />
          Undo
        </motion.button>
      )}
    </AnimatePresence>
  );
}
