"use client";

import { useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useModalChrome } from "@/hooks/useModalChrome";

interface MoveToFolderDialogProps {
  /** @param open - Whether the dialog is open. */
  open: boolean;
  /** @param title - What is being moved (note or folder name). */
  title: string;
  /** @param folders - Selectable destination folder paths (root implied). */
  folders: string[];
  /** @param currentPath - The item's current folder, shown as selected. */
  currentPath: string;
  /** @param onPick - Move to the chosen folder path (`""` = root). */
  onPick: (dest: string) => void;
  /** @param onCancel - Dismiss without moving. */
  onCancel: () => void;
}

/**
 * Touch-friendly "move to folder" picker: a centered modal listing the
 * root and every folder, so notes and folders can be reorganized on
 * coarse pointers where native HTML5 drag never fires. Dialog chrome
 * (Escape, focus trap, focus restore) comes from {@link useModalChrome}.
 *
 * @param props - Open flag, destinations, and move/cancel wiring.
 * @returns Backdrop + centered folder list, or nothing while closed.
 */
export function MoveToFolderDialog({
  open,
  title,
  folders,
  currentPath,
  onPick,
  onCancel,
}: MoveToFolderDialogProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useModalChrome(open, onCancel, panelRef);

  const destinations = ["", ...folders];

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
              role="dialog"
              aria-modal="true"
              aria-label={`Move ${title}`}
              className="flex max-h-[70vh] w-full max-w-[360px] flex-col rounded-xl border border-border shadow-[var(--shadow-float)]"
              style={{ background: "var(--color-surface)" }}
            >
              <div className="border-b border-border px-4 py-3">
                <h2
                  className="truncate text-[13px] font-semibold"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  Move “{title}”
                </h2>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {destinations.map((dest) => {
                  const isCurrent = dest === currentPath;
                  return (
                    <button
                      key={dest || "__root__"}
                      type="button"
                      disabled={isCurrent}
                      onClick={() => onPick(dest)}
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-default disabled:text-text-faint"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {dest === "" ? "Root" : dest}
                      </span>
                      {isCurrent && (
                        <span className="font-mono text-[10px] text-text-faint">
                          current
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </motion.aside>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
