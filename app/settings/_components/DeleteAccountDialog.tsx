"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { useModalChrome } from "@/hooks/useModalChrome";
import { deleteAccountAction } from "@/lib/actions/profile";

const INPUT_CLASS =
  "w-full rounded-lg border border-border-strong bg-base px-4 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent";

interface DeleteAccountDialogProps {
  /** Modal visibility. */
  open: boolean;
  /** Signed-in user's email — one of the accepted confirmation phrases. */
  email: string;
  /** Called when the user dismisses the modal (ESC, backdrop, Cancel). */
  onClose: () => void;
}

/**
 * Two-stage account-deletion dialog. Typed-confirmation gate: the user
 * must type their email or the literal word DELETE. On confirm it calls
 * `deleteAccountAction`; on success the session is gone, so the user is
 * redirected to `/sign-in`. The sole-owner block surfaces inline so the
 * user can transfer or delete the offending team first. No password field
 * and no email round-trip.
 *
 * Mounts the body only while `open` is true so state resets on each open.
 *
 * @param props - Dialog configuration.
 * @returns Modal overlay rendered inline.
 */
export function DeleteAccountDialog({
  open,
  email,
  onClose,
}: DeleteAccountDialogProps) {
  return (
    <AnimatePresence>
      {open ? (
        <DeleteAccountDialogBody
          key="delete-account-dialog"
          email={email}
          onClose={onClose}
        />
      ) : null}
    </AnimatePresence>
  );
}

interface DeleteAccountDialogBodyProps {
  email: string;
  onClose: () => void;
}

/**
 * Mounted dialog body — owns the typed-confirmation input and the delete
 * transition. Modal chrome (Esc, focus trap, focus restore) comes from
 * {@link useModalChrome}.
 *
 * @param props - Email and close handler.
 * @returns The dialog panel.
 */
function DeleteAccountDialogBody({
  email,
  onClose,
}: DeleteAccountDialogBodyProps) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useModalChrome(true, onClose, panelRef);

  const canConfirm = (typed === email || typed === "DELETE") && !pending;

  const handleConfirm = () => {
    if (!canConfirm) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteAccountAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.replace("/sign-in");
    });
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-account-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[70] flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        disabled={pending}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm disabled:cursor-not-allowed"
      />
      <motion.div
        ref={panelRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="relative w-full max-w-md rounded-xl border border-danger/30 bg-surface p-6 shadow-[var(--shadow-float)]"
      >
        <h3
          id="delete-account-title"
          className="text-lg font-semibold text-text-primary"
        >
          Delete your account?
        </h3>

        <div className="mt-3 rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-text-secondary">
          This permanently erases your profile and revokes every authorized
          agent and session. Teams you solely own with no other members are
          deleted with their projects and tasks. Legal-acceptance records are
          anonymized and retained as required evidence. This cannot be undone.
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">
            Type <span className="font-mono text-text-primary">{email}</span> or{" "}
            <span className="font-mono text-text-primary">DELETE</span> to
            confirm
          </span>
          <input
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={pending}
            autoFocus
            autoComplete="off"
            placeholder="DELETE"
            className={INPUT_CLASS}
          />
        </label>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <motion.button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-busy={pending || undefined}
            whileHover={canConfirm ? { scale: 1.02 } : undefined}
            whileTap={canConfirm ? { scale: 0.98 } : undefined}
            className={`inline-flex min-h-10 items-center justify-center rounded-md border px-4 py-2 text-sm font-semibold transition-colors ${
              canConfirm
                ? "cursor-pointer border-danger/40 bg-danger/10 text-danger hover:border-danger hover:bg-danger/15"
                : "cursor-not-allowed border-border bg-transparent text-text-muted opacity-40"
            }`}
          >
            {pending ? (
              <span className="flex items-center gap-1">
                <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
              </span>
            ) : (
              "Delete account"
            )}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
