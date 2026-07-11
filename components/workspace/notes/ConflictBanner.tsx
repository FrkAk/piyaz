"use client";

import { useState } from "react";
import { IconBranch } from "@/components/shared/icons";
import type { NoteFullResult } from "@/lib/data/note";
import { tint } from "./note-meta";
import type { NoteAutosaveConflict } from "./useNoteMutations";
import { NoteMarkdown } from "./NoteMarkdown";

/** Small action button shared by the banner's recovery controls. */
const ACTION_CLASS =
  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 cursor-pointer";

/** Remote-preview fetch lifecycle. */
type RemotePreview =
  | { phase: "closed" }
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "loaded"; title: string; body: string };

interface ConflictBannerProps {
  /** @param noteId - Conflicted note id, for the remote preview fetch. */
  noteId: string;
  /** @param conflict - Live conflict payload from `useNoteAutosave`. */
  conflict: NoteAutosaveConflict;
  /** @param identifier - Owning project identifier for inline task refs. */
  identifier: string;
  /** @param localTitle - The kept local title, to show the remote title only when it differs. */
  localTitle: string;
  /** @param onDiscard - Drop the local draft and adopt the remote version. */
  onDiscard: () => void;
  /** @param onKeepMine - Re-apply the local draft over the remote version. */
  onKeepMine: () => void;
}

/**
 * Human phrase for the conflicted fields.
 *
 * @param fields - Conflicted field names from the stashed patch.
 * @returns Copy fragment naming what changed.
 */
function fieldsPhrase(fields: NoteAutosaveConflict["fields"]): string {
  if (fields.length === 2) return "title and note body";
  return fields[0] === "title" ? "title" : "note body";
}

/**
 * Non-blocking conflict banner rendered under the editor meta line after
 * a `stale_write` flush. Names the conflicted fields and the fresh remote
 * version, and owns the recovery actions: an inline read-only remote
 * preview, discard-local, and keep-mine. The preview fetch deliberately
 * bypasses the query cache: writing the remote payload into the detail
 * entry would clobber the kept-optimistic local content. Entrance rides
 * the global `rise-in` CSS animation, which the app-wide
 * `prefers-reduced-motion` clamp suppresses with zero component code.
 *
 * @param props - Conflict payload, preview scope, and recovery handlers.
 * @returns The banner row with its optional inline preview.
 */
export function ConflictBanner({
  noteId,
  conflict,
  identifier,
  localTitle,
  onDiscard,
  onKeepMine,
}: ConflictBannerProps) {
  const [preview, setPreview] = useState<RemotePreview>({ phase: "closed" });

  const loadPreview = async () => {
    setPreview({ phase: "loading" });
    try {
      const res = await fetch(`/api/note/${noteId}`);
      if (!res.ok) throw new Error(`remote preview ${res.status}`);
      const result = (await res.json()) as NoteFullResult;
      setPreview({
        phase: "loaded",
        title: result.note.title,
        body: result.note.body,
      });
    } catch {
      setPreview({ phase: "error" });
    }
  };

  return (
    <div
      className="rise-in mb-4 rounded-lg px-3 py-2.5 text-[12px] leading-relaxed"
      role="alert"
      style={{
        background: tint("var(--color-danger)", 8),
        border: `1px solid ${tint("var(--color-danger)", 30)}`,
        color: "var(--color-text-secondary)",
      }}
    >
      <div className="flex items-start gap-2">
        <span style={{ color: "var(--color-danger)", marginTop: 1 }}>
          <IconBranch size={13} />
        </span>
        <span className="min-w-0">
          <strong
            style={{ color: "var(--color-text-primary)", fontWeight: 600 }}
          >
            This note changed elsewhere.
          </strong>{" "}
          Someone saved a newer version{" "}
          <span className="whitespace-nowrap font-mono text-[10px] text-text-muted">
            v{conflict.currentVersion}
          </span>{" "}
          while you edited the {fieldsPhrase(conflict.fields)}. Your edits are
          safe and unsaved.
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[21px]">
        <button
          type="button"
          onClick={() => {
            if (preview.phase === "closed") void loadPreview();
            else setPreview({ phase: "closed" });
          }}
          className={`${ACTION_CLASS} border border-border text-text-secondary hover:bg-surface-hover`}
        >
          {preview.phase === "closed" ? "View remote" : "Hide remote"}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className={`${ACTION_CLASS} border text-text-secondary hover:bg-surface-hover`}
          style={{
            borderColor: tint("var(--color-danger)", 40),
            color: "var(--color-danger)",
          }}
        >
          Discard my edits
        </button>
        <button
          type="button"
          onClick={onKeepMine}
          className={`${ACTION_CLASS} text-white`}
          style={{ background: "var(--color-accent-fill)" }}
        >
          Keep mine
        </button>
      </div>
      {preview.phase === "loading" && (
        <p className="mt-2 pl-[21px] font-mono text-[10px] text-text-faint">
          loading remote version…
        </p>
      )}
      {preview.phase === "error" && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 pl-[21px] text-[11px] text-text-muted">
          Couldn&apos;t load the remote version.
          <button
            type="button"
            onClick={() => void loadPreview()}
            className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            Retry
          </button>
        </p>
      )}
      {preview.phase === "loaded" && (
        <div
          className="mt-2.5 max-h-72 overflow-y-auto rounded-md border border-border px-3 py-2.5"
          style={{ background: "var(--color-base)" }}
        >
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-faint">
            Remote version
          </p>
          {preview.title !== localTitle && (
            <p
              className="mb-1.5 text-[15px] font-semibold"
              style={{ color: "var(--color-text-primary)" }}
            >
              {preview.title.trim() === "" ? "Untitled note" : preview.title}
            </p>
          )}
          {preview.body.trim() === "" ? (
            <p className="text-[12px] italic text-text-faint">Empty note</p>
          ) : (
            <NoteMarkdown body={preview.body} identifier={identifier} />
          )}
        </div>
      )}
    </div>
  );
}
