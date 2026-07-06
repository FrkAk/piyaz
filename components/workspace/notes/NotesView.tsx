"use client";

import { useCallback, useState } from "react";
import { EditorPane } from "./EditorPane";
import { TreePane } from "./TreePane";
import { useCreateNote } from "./useNoteMutations";

interface NotesViewProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param noteId - Selected note id from the `?note` query param, or null. */
  noteId: string | null;
  /** @param onSelectNote - Write `?note=<id>` (null clears) — the selection contract the notes panes call. */
  onSelectNote: (noteId: string | null) => void;
}

/**
 * Notes workspace view — the tree pane beside the editor pane. Owns the
 * no-modal create flow: New note persists immediately, selects the created
 * note, and focuses its title. The settings column mounts here later.
 *
 * @param props - Project scope, selected note id, and selection writer.
 * @returns Full-height notes shell.
 */
export function NotesView({ projectId, noteId, onSelectNote }: NotesViewProps) {
  const createNote = useCreateNote(projectId);
  const [focusTitle, setFocusTitle] = useState<string | null>(null);

  /**
   * Create a persisted note in a folder, then select it and request
   * title focus. Selection only moves on the authoritative server id;
   * on failure the hook restores the tree and selection stays put.
   *
   * @param folder - Target folder path.
   */
  async function createAndSelect(folder: string) {
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
      return;
    }
    if (result.ok) {
      onSelectNote(result.data.id);
      setFocusTitle(result.data.id);
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
      />
      <EditorPane
        projectId={projectId}
        noteId={noteId}
        focusTitle={focusTitle}
        onFocusedTitle={handleFocusedTitle}
      />
    </div>
  );
}

export default NotesView;
