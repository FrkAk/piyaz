"use client";

import { useCallback, useState } from "react";
import { EditorPane } from "./EditorPane";
import { TreePane } from "./TreePane";
import { useCreateNote } from "./useNoteMutations";

interface NotesViewProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param projectIdentifier - Owning project identifier for inline task refs. */
  projectIdentifier: string;
  /** @param noteId - Selected note id from the `?note` query param, or null. */
  noteId: string | null;
  /** @param onSelectNote - Write `?note=<id>` (null clears) — the selection contract the notes panes call. */
  onSelectNote: (noteId: string | null) => void;
  /** @param onSelectTask - Open a task's detail from an inline editor chip. */
  onSelectTask: (taskId: string) => void;
}

/**
 * Notes workspace view: the tree pane beside the editor pane. Owns the
 * no-modal create flow: New note persists immediately, selects the created
 * note, and focuses its title.
 *
 * @param props - Project scope, selected note id, and selection writer.
 * @returns Full-height notes shell.
 */
export function NotesView({
  projectId,
  projectIdentifier,
  noteId,
  onSelectNote,
  onSelectTask,
}: NotesViewProps) {
  const createNote = useCreateNote(projectId);
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  /**
   * Create a persisted note in a folder, then select it and request
   * title focus. Selection only moves on the authoritative server id;
   * on failure the hook restores the tree, selection stays put, and the
   * failure surfaces in the tree pane's error strip.
   *
   * @param folder - Target folder path.
   */
  async function createAndSelect(folder: string) {
    setCreateError(null);
    let result: Awaited<ReturnType<typeof createNote.mutateAsync>>;
    try {
      result = await createNote.mutateAsync({
        title: "",
        body: "## Overview\n",
        folder,
        type: "reference",
        visibility: "private",
      });
    } catch {
      setCreateError("Create failed");
      return;
    }
    if (result.ok) {
      onSelectNote(result.data.id);
      setFocusTitle(result.data.id);
    } else {
      setCreateError(result.message);
    }
  }

  const handleFocusedTitle = useCallback(() => setFocusTitle(null), []);

  return (
    <div className="flex h-full w-full">
      <TreePane
        projectId={projectId}
        selectedId={noteId}
        onSelect={onSelectNote}
        onNewNote={(folder) => void createAndSelect(folder)}
        createPending={createNote.isPending}
        createError={createError}
      />
      <EditorPane
        projectId={projectId}
        projectIdentifier={projectIdentifier}
        noteId={noteId}
        focusTitle={focusTitle}
        onFocusedTitle={handleFocusedTitle}
        onSelectTask={onSelectTask}
        onSelectNote={onSelectNote}
      />
    </div>
  );
}

export default NotesView;
