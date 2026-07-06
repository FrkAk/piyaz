"use client";

import { useEffect, useRef, useState } from "react";
import { useNoteDetail } from "./useNoteDetail";
import { useUpdateNote } from "./useNoteMutations";

interface EditorPaneProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param noteId - Selected note id, or null. */
  noteId: string | null;
  /** @param focusTitle - Note id whose title input should take focus, or null. */
  focusTitle: string | null;
  /** @param onFocusedTitle - Clears the focus request once applied. */
  onFocusedTitle: () => void;
}

/**
 * Center pane, the editor column. Renders the empty state without a
 * selection, otherwise the editable note title.
 *
 * @param props - Project scope, selection, and title-focus wiring.
 * @returns The flexible editor column.
 */
export function EditorPane({
  projectId,
  noteId,
  focusTitle,
  onFocusedTitle,
}: EditorPaneProps) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ background: "var(--color-base)" }}
    >
      {noteId === null ? (
        <div className="flex h-full items-center justify-center">
          <p className="text-[12px] text-text-muted">No note selected</p>
        </div>
      ) : (
        <EditorBody
          key={noteId}
          projectId={projectId}
          noteId={noteId}
          shouldFocusTitle={focusTitle === noteId}
          onFocusedTitle={onFocusedTitle}
        />
      )}
    </div>
  );
}

interface EditorBodyProps {
  projectId: string;
  noteId: string;
  shouldFocusTitle: boolean;
  onFocusedTitle: () => void;
}

/**
 * Loaded-note body: the editable H1 title over the note detail query.
 * Mounted only with a live selection so the detail query is never keyed
 * on an empty id; remounted per note via `key`.
 *
 * @param props - Selected note and title-focus wiring.
 * @returns The note content column, a not-found line, or null while loading.
 */
function EditorBody({
  projectId,
  noteId,
  shouldFocusTitle,
  onFocusedTitle,
}: EditorBodyProps) {
  const { data, isError } = useNoteDetail(projectId, noteId);
  const updateNote = useUpdateNote(projectId);
  const note = data?.note;
  const [title, setTitle] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (title === null && note !== undefined) setTitle(note.title);

  const ready = note !== undefined;
  useEffect(() => {
    if (!shouldFocusTitle || !ready) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
    onFocusedTitle();
  }, [shouldFocusTitle, ready, onFocusedTitle]);

  if (note === undefined) {
    if (!isError) return null;
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12px] text-text-muted">Note not found</p>
      </div>
    );
  }

  /** Persist the title draft when it differs from the saved title. */
  function commitTitle() {
    if (note === undefined || note.locked) return;
    if (title === null || title === note.title) return;
    updateNote.mutate({ noteId, patch: { title } });
  }

  return (
    <div
      className="mx-auto"
      style={{ maxWidth: 760, padding: "28px 34px 64px" }}
    >
      <input
        ref={inputRef}
        value={title ?? ""}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitTitle();
        }}
        readOnly={note.locked}
        placeholder="Untitled note"
        className="mb-2.5 w-full bg-transparent outline-none placeholder:text-text-faint"
        style={{
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--color-text-primary)",
        }}
      />
    </div>
  );
}
