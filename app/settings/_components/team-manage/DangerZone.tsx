"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { DeleteTeamDialog } from "./DeleteTeamDialog";

interface DangerZoneProps {
  /** Team UUID — passed to the delete action. */
  teamId: string;
  /** Team display name — required for the typed-name confirm. */
  teamName: string;
  /** Surface a transient error from the delete flow. */
  onError: (message: string) => void;
}

/**
 * Danger zone — owner-only section housing the delete-team action.
 * Visually separated from the rest of the page with a danger-tinted
 * border and copy explaining the cascade impact. The button itself
 * just opens the typed-name confirm dialog; destructive intent is
 * always two-stage.
 *
 * @param props - Section configuration.
 * @returns Card with the destructive action and modal trigger.
 */
export function DangerZone({ teamId, teamName, onError }: DangerZoneProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-danger">
        Danger zone
      </p>
      <div className="rounded-xl border border-danger/25 bg-danger/5 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">
              Delete this team
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Removes every project, task, dependency, and pending invitation in
              this team. All members lose access immediately. User accounts are
              not touched: members keep their accounts and any other teams. This
              action cannot be undone.
            </p>
          </div>
          <motion.button
            type="button"
            onClick={() => setOpen(true)}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border border-danger/40 bg-transparent px-4 py-2 text-sm font-semibold text-danger transition-colors hover:border-danger hover:bg-danger/10"
          >
            Delete team…
          </motion.button>
        </div>
      </div>

      <DeleteTeamDialog
        open={open}
        teamId={teamId}
        teamName={teamName}
        onClose={() => setOpen(false)}
        onError={onError}
      />
    </section>
  );
}
