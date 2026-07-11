"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconUndo } from "@/components/shared/icons";
import { SectionHeader } from "@/components/shared/SectionHeader";
import { formatRelative } from "@/components/workspace/structure/relativeTime";
import type { NoteActionFailure } from "@/lib/actions/note-errors";
import { conditionalFetch } from "@/lib/query/conditional-fetch";
import { noteKeys } from "@/lib/query/keys";
import { hasUnsavedNoteEdits, useNoteDirty } from "@/lib/query/note-cache";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  useRestoreRevision,
  type NoteRevisionsCache,
} from "./useNoteMutations";

interface NoteVersionsProps {
  /** @param projectId - Owning project id (for the query key). */
  projectId: string;
  /** @param noteId - Note whose revisions to list. */
  noteId: string;
  /** @param locked - Whether the note is locked (restore disabled). */
  locked: boolean;
  /** @param loading - Whether the detail is still placeholder data. */
  loading: boolean;
  /** @param currentVersion - Live note version from the detail. */
  currentVersion: number;
  /** @param currentTitle - Live note title for the current row. */
  currentTitle: string;
  /** @param currentUpdatedAt - Live `updatedAt` for the current row. */
  currentUpdatedAt: string | Date;
}

/**
 * A short, human-facing line for a failed restore.
 *
 * @param failure - The typed failure from the restore action.
 * @returns One-line copy for the panel's inline error slot.
 */
function restoreFailureCopy(failure: NoteActionFailure): string {
  switch (failure.code) {
    case "stale_write":
      return "note changed elsewhere, list refreshed";
    case "rate_limited":
      return "too many changes, try again shortly";
    case "locked":
      return "note is locked";
    case "archived":
      return "project archived";
    case "invalid_input":
      return "that version no longer exists";
    case "unauthorized":
      return "sign in to restore";
    default:
      return "restore failed";
  }
}

interface VersionRowProps {
  /** @param version - Version number for the chip. */
  version: number;
  /** @param title - Note title at this version. */
  title: string;
  /** @param createdAt - When this version's content was written. */
  createdAt: string | Date;
  /** @param isCurrent - Accent the chip and show the current marker. */
  isCurrent: boolean;
  /** @param nowMs - Reference time for the relative tag, ticked by the panel. */
  nowMs: number;
  /** @param children - Trailing control (the restore button), if any. */
  children?: React.ReactNode;
}

/**
 * One row of the Versions list: version chip, truncated title, relative
 * time, and either the current marker or a caller-supplied control.
 *
 * @param props - Row identity, current flag, reference time, and optional
 *   trailing control.
 * @returns The list item element.
 */
function VersionRow({
  version,
  title,
  createdAt,
  isCurrent,
  nowMs,
  children,
}: VersionRowProps) {
  const createdAtIso =
    typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  return (
    <li className="group/version flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-hover">
      <span
        className="shrink-0 rounded px-1 font-mono text-[10px] tabular-nums"
        style={{
          color: isCurrent
            ? "var(--color-accent-light)"
            : "var(--color-text-faint)",
          background: isCurrent
            ? "var(--color-accent-glow)"
            : "var(--color-surface)",
          border: `1px solid ${
            isCurrent ? "var(--color-accent)" : "var(--color-border)"
          }`,
        }}
      >
        v{version}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[12px] text-text-secondary"
        title={title}
      >
        {title}
      </span>
      <time
        dateTime={createdAtIso}
        title={new Date(createdAtIso).toLocaleString()}
        className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint"
      >
        {formatRelative(createdAtIso, nowMs)}
      </time>
      {isCurrent && (
        <span className="shrink-0 font-mono text-[9px] uppercase text-text-faint">
          current
        </span>
      )}
      {children}
    </li>
  );
}

/**
 * Versions panel for the settings ribbon: the live state pinned as
 * `current` on top (from the detail, since checkpoints archive pre-images
 * and the newest content lives only on the note), then the stored
 * checkpoints newest-first with a restore control each. Restore is
 * append-only (the pre-restore state is checkpointed first, so nothing is
 * destroyed) and is confirmed through the shared {@link ConfirmDialog}.
 * The control is disabled while the note is locked, still loading, or
 * holds unsaved editor content (a restore under a dirty buffer would race
 * the autosave; the server CAS is the backstop).
 *
 * @param props - Project scope, the open note, its gate flags, and the
 *   live version identity for the current row.
 * @returns The Versions ribbon section.
 */
export function NoteVersions({
  projectId,
  noteId,
  locked,
  loading,
  currentVersion,
  currentTitle,
  currentUpdatedAt,
}: NoteVersionsProps) {
  const restore = useRestoreRevision(projectId);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const qc = useQueryClient();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: noteKeys.revisions(projectId, noteId),
    queryFn: ({ signal }) =>
      conditionalFetch<NoteRevisionsCache>({
        url: `/api/note/${noteId}/revisions`,
        queryKey: noteKeys.revisions(projectId, noteId),
        queryClient: qc,
        signal,
      }),
  });

  const dirty = useNoteDirty(noteId);
  const blocked = locked || loading || pendingVersion !== null;

  const runRestore = async (version: number) => {
    setConfirmVersion(null);
    if (hasUnsavedNoteEdits(noteId)) {
      setError("save or resolve open edits first");
      return;
    }
    setPendingVersion(version);
    setError(null);
    try {
      const result = await restore.mutateAsync({ noteId, version });
      if (!result.ok) setError(restoreFailureCopy(result));
    } catch {
      setError("restore failed");
    } finally {
      setPendingVersion(null);
    }
  };

  return (
    <div className="mt-6">
      <SectionHeader
        label="Versions"
        count={
          data !== undefined && data.revisions.length > 0
            ? data.revisions.length
            : undefined
        }
      />
      <p className="mb-2 text-[11px] leading-snug text-text-muted">
        Checkpoints from past editing sessions. Restoring is reversible: the
        current content is checkpointed first.
      </p>
      {isPending ? (
        <div className="space-y-2" role="status" aria-label="Loading versions">
          <span className="skeleton-bar block h-5 w-full" />
          <span
            className="skeleton-bar block h-5 w-5/6"
            style={{ "--skeleton-delay": "70ms" } as React.CSSProperties}
          />
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 py-1 text-[12px] text-text-secondary">
          <span>Couldn&rsquo;t load versions.</span>
          <button
            type="button"
            onClick={() => refetch()}
            className="cursor-pointer text-text-muted underline hover:text-text-secondary"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-0.5">
            {(data.revisions[0] === undefined ||
              currentVersion > data.revisions[0].version) && (
              <VersionRow
                version={currentVersion}
                title={currentTitle}
                createdAt={currentUpdatedAt}
                isCurrent
                nowMs={nowMs}
              />
            )}
            {data.revisions.map((rev) => {
              const isCurrent = rev.version === currentVersion;
              const isPendingRow = pendingVersion === rev.version;
              return (
                <VersionRow
                  key={rev.version}
                  version={rev.version}
                  title={rev.title}
                  createdAt={rev.createdAt}
                  isCurrent={isCurrent}
                  nowMs={nowMs}
                >
                  {!isCurrent && (
                    <button
                      type="button"
                      disabled={blocked || dirty}
                      onClick={() => setConfirmVersion(rev.version)}
                      title={
                        dirty
                          ? "Save or resolve open edits first"
                          : locked
                            ? "Note is locked"
                            : loading
                              ? "Loading note"
                              : `Restore v${rev.version}`
                      }
                      aria-label={`Restore version ${rev.version}`}
                      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase text-text-muted transition-colors hover:bg-accent-glow hover:text-accent-light focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <IconUndo size={10} />
                      {isPendingRow ? "Restoring…" : "Restore"}
                    </button>
                  )}
                </VersionRow>
              );
            })}
          </ul>
          {data.revisions.length === 0 && (
            <div className="py-0.5 text-[12px] text-text-faint">
              No checkpoints yet. Versions appear as editing sessions end.
            </div>
          )}
        </>
      )}
      {error !== null && pendingVersion === null && (
        <p
          role="status"
          className="mt-1 font-mono text-[10px]"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmVersion !== null}
        title={`Restore v${confirmVersion ?? ""}?`}
        body={
          <>
            The note&rsquo;s title and body revert to version{" "}
            {confirmVersion ?? ""}. Nothing is lost: the current content stays
            available as its own version.
          </>
        }
        confirmLabel="Restore"
        tone="neutral"
        onConfirm={() => {
          if (confirmVersion !== null) void runRestore(confirmVersion);
        }}
        onCancel={() => setConfirmVersion(null)}
      />
    </div>
  );
}

export default NoteVersions;
