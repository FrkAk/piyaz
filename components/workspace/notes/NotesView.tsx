"use client";

interface NotesViewProps {
  /** @param noteId - Selected note id from the `?note` query param, or null. */
  noteId: string | null;
  /** @param onSelectNote - Write `?note=<id>` (null clears) — the selection contract the notes panes call. */
  onSelectNote: (noteId: string | null) => void;
}

/**
 * Notes workspace view. Currently a placeholder proving the `?view=notes`
 * routing and `?note=<id>` selection wiring; the three-pane notes layout
 * replaces this body while keeping the same prop contract.
 *
 * @param props - Selected note id and selection writer.
 * @returns Full-height placeholder pane.
 */
export function NotesView({ noteId, onSelectNote }: NotesViewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-sm text-text-secondary">Notes</p>
      <p className="mt-1 max-w-sm text-xs text-text-muted">
        The notes workspace lands here next.
      </p>
      {noteId ? (
        <>
          <p className="mt-3 font-mono text-[11px] text-text-muted">{noteId}</p>
          <button
            type="button"
            onClick={() => onSelectNote(null)}
            className="mt-1 cursor-pointer text-[11px] text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
          >
            Clear selection
          </button>
        </>
      ) : null}
    </div>
  );
}

export default NotesView;
