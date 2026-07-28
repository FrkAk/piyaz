"use client";

import { useId, useState, useTransition, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

interface InlineConfirmProps {
  /** Trigger UI (typically a Button) rendered in the idle state. */
  trigger: ReactNode;
  /** Prompt copy shown when the user enters confirm mode. */
  prompt: string;
  /** Optional secondary line under the prompt. */
  body?: ReactNode;
  /** Confirm button label, e.g. "Yes, revoke". */
  confirmLabel: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When true, applies the cancelled-tinted destructive style to the confirm button. */
  destructive?: boolean;
  /** Async callback executed when the user confirms. */
  onConfirm: () => Promise<void>;
}

/**
 * Inline two-step confirmation primitive. Renders the `trigger` while
 * idle; on click swaps to a Cancel/Confirm pair without a modal so the
 * action stays in flow. The prompt and body render at every viewport,
 * announce on entry (`role="alert"` — a mounted polite region is not
 * reliably read), and describe the confirm button. Used for
 * revoke-session and leave-team.
 *
 * @param props - Confirm primitive configuration.
 * @returns Animated swap between trigger and confirm controls.
 */
export function InlineConfirm({
  trigger,
  prompt,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
}: InlineConfirmProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const promptId = useId();
  const bodyId = useId();

  const handleTrigger = () => setConfirming(true);
  const handleCancel = () => setConfirming(false);
  const handleConfirm = () => {
    startTransition(async () => {
      try {
        await onConfirm();
      } finally {
        setConfirming(false);
      }
    });
  };

  const confirmClasses = destructive
    ? "border-cancelled/30 bg-cancelled/10 text-cancelled hover:bg-cancelled/15"
    : "border-border-strong bg-transparent text-text-primary hover:opacity-60";

  return (
    <AnimatePresence mode="wait" initial={false}>
      {confirming ? (
        <motion.div
          key="confirm"
          layout
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15 }}
          className="flex flex-wrap items-center justify-end gap-2"
        >
          <div role="alert" className="min-w-0 text-right">
            <p id={promptId} className="text-xs font-medium text-text-primary">
              {prompt}
            </p>
            {body ? (
              <p id={bodyId} className="text-[11px] text-text-muted">
                {body}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            aria-busy={pending || undefined}
            aria-describedby={body ? `${promptId} ${bodyId}` : promptId}
            className={`inline-flex min-h-9 cursor-pointer items-center justify-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${confirmClasses}`}
          >
            {pending ? (
              <span className="flex items-center gap-1">
                <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </motion.div>
      ) : (
        <motion.div
          key="idle"
          layout
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15 }}
          onClick={handleTrigger}
        >
          {trigger}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
