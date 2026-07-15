"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { useModalChrome } from "@/hooks/useModalChrome";
import {
  deleteTeamAction,
  previewTeamDeleteAction,
  type TeamDeletePreview,
} from "@/lib/actions/team";

const INPUT_CLASS =
  "w-full rounded-lg border border-border-strong bg-base px-4 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent";

interface DeleteTeamDialogProps {
  /** Modal visibility. */
  open: boolean;
  /** Team UUID — sent with both preview and delete actions. */
  teamId: string;
  /** Team display name — must be typed back to enable the destroy button. */
  teamName: string;
  /** Called when the user dismisses the modal (ESC, backdrop, Cancel). */
  onClose: () => void;
  /** Surface a transient error from the delete action. */
  onError: (message: string) => void;
}

/**
 * Two-stage destroy dialog. Modal overlay + typed-name confirmation +
 * lazy-loaded cascade preview ("N projects, M tasks will be removed").
 * Owner-gated upstream (DangerZone only renders for owners) AND
 * server-side via `deleteTeamAction → isOrgOwner()`.
 *
 * Closes on ESC and backdrop click. After a successful delete the user
 * is redirected to `/` since the team they were on is gone — the workspace
 * spans every remaining team membership so the home grid takes over.
 *
 * Mounts the body only while `open` is true — keeps state-reset and the
 * cascade-preview fetch tied to mount lifecycle so the lint
 * `react-hooks/set-state-in-effect` rule stays clean.
 *
 * @param props - Dialog configuration.
 * @returns Modal portal-style overlay rendered inline.
 */
export function DeleteTeamDialog({
  open,
  teamId,
  teamName,
  onClose,
  onError,
}: DeleteTeamDialogProps) {
  return (
    <AnimatePresence>
      {open ? (
        <DeleteTeamDialogBody
          key="delete-team-dialog"
          teamId={teamId}
          teamName={teamName}
          onClose={onClose}
          onError={onError}
        />
      ) : null}
    </AnimatePresence>
  );
}

interface DeleteTeamDialogBodyProps {
  teamId: string;
  teamName: string;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * Mounted dialog body — owns the typed-name input state and the lazy
 * cascade-preview fetch. Mounting on `open=true` resets state for free
 * and avoids the setState-in-effect anti-pattern.
 *
 * Modal chrome (Esc, Tab focus trap, focus restore on unmount) is
 * provided by {@link useModalChrome}, which registers this dialog on a
 * shared stack so when it opens above the team-manage modal a single
 * Esc dismisses only the topmost dialog.
 */
function DeleteTeamDialogBody({
  teamId,
  teamName,
  onClose,
  onError,
}: DeleteTeamDialogBodyProps) {
  const [typedName, setTypedName] = useState("");
  const [preview, setPreview] = useState<TeamDeletePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [pending, startTransition] = useTransition();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useModalChrome(true, onClose, panelRef);

  useEffect(() => {
    let cancelled = false;
    previewTeamDeleteAction({ organizationId: teamId })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPreview(result.data);
        } else {
          onError(result.message);
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, onError]);

  const canConfirm = typedName === teamName && !pending;

  const handleConfirm = () => {
    if (!canConfirm) return;
    startTransition(async () => {
      const result = await deleteTeamAction({ organizationId: teamId });
      if (!result.ok) {
        onError(result.message);
        return;
      }
      window.location.href = "/";
    });
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-team-title"
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
          id="delete-team-title"
          className="text-lg font-semibold text-text-primary"
        >
          Delete <span className="text-danger">{teamName}</span>?
        </h3>

        <div className="mt-3 rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-text-secondary">
          {previewLoading || !preview ? (
            <p className="flex items-center gap-2 text-text-muted">
              <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
              <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
              <span className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
              <span>Loading impact…</span>
            </p>
          ) : (
            <p>
              This permanently removes{" "}
              <span className="font-semibold text-text-primary">
                {preview.projectCount}{" "}
                {preview.projectCount === 1 ? "project" : "projects"}
              </span>
              ,{" "}
              <span className="font-semibold text-text-primary">
                {preview.taskCount} {preview.taskCount === 1 ? "task" : "tasks"}
              </span>
              , every dependency edge, all team invitations, and revokes every
              member&apos;s MCP sessions. User accounts stay.
            </p>
          )}
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">
            Type <span className="font-mono text-text-primary">{teamName}</span>{" "}
            to confirm
          </span>
          <input
            type="text"
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
            disabled={pending}
            autoFocus
            placeholder={teamName}
            className={INPUT_CLASS}
          />
        </label>

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
              "Delete team"
            )}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
