"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconPanelLeft } from "@/components/shared/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useModalChrome } from "@/hooks/useModalChrome";
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
 * Notes workspace view. At `lg` and up the tree pane sits beside the
 * editor pane; below `lg` the editor takes the full width and the tree
 * becomes a slide-over drawer opened from the pane header, closed by
 * selecting a note, the close button, backdrop, or Escape. Owns the
 * no-modal create flow: New note persists immediately, selects the
 * created note, and focuses its title.
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
  const isLg = useMediaQuery("(min-width: 1024px)", true);
  const createNote = useCreateNote(projectId);
  const [treeOpen, setTreeOpen] = useState(false);
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
      setTreeOpen(false);
      setFocusTitle(result.data.id);
    } else {
      setCreateError(result.message);
    }
  }

  const handleFocusedTitle = useCallback(() => setFocusTitle(null), []);

  const handleSelect = useCallback(
    (nextNoteId: string) => {
      onSelectNote(nextNoteId);
      setTreeOpen(false);
    },
    [onSelectNote],
  );

  const closeTree = useCallback(() => setTreeOpen(false), []);

  const editor = (
    <EditorPane
      projectId={projectId}
      projectIdentifier={projectIdentifier}
      noteId={noteId}
      focusTitle={focusTitle}
      onFocusedTitle={handleFocusedTitle}
      onSelectTask={onSelectTask}
      onSelectNote={onSelectNote}
    />
  );

  if (isLg) {
    return (
      <div className="flex h-full w-full">
        <TreePane
          projectId={projectId}
          selectedId={noteId}
          onSelect={handleSelect}
          onNewNote={(folder) => void createAndSelect(folder)}
          createPending={createNote.isPending}
          createError={createError}
        />
        {editor}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border px-2"
        style={{ height: 40, background: "var(--color-base-2)" }}
      >
        <button
          type="button"
          onClick={() => setTreeOpen(true)}
          aria-label="Browse notes"
          title="Browse notes"
          className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <IconPanelLeft size={15} />
        </button>
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Notes
        </span>
      </div>
      {editor}
      <TreeDrawer open={treeOpen} onClose={closeTree}>
        <TreePane
          fill
          projectId={projectId}
          selectedId={noteId}
          onSelect={handleSelect}
          onNewNote={(folder) => void createAndSelect(folder)}
          createPending={createNote.isPending}
          createError={createError}
          onClose={closeTree}
        />
      </TreeDrawer>
    </div>
  );
}

interface TreeDrawerProps {
  /** @param open - Whether the drawer is open. */
  open: boolean;
  /** @param onClose - Close the drawer. */
  onClose: () => void;
  /** @param children - Drawer body, the fill-mode tree pane. */
  children: React.ReactNode;
}

/**
 * Slide-out drawer wrapping the notes tree for viewports below `lg`.
 * Closes on backdrop click and on Esc. Dialog chrome (Escape via the
 * shared modal stack, Tab focus trap, focus seed and restore) comes from
 * {@link useModalChrome}; the global `MotionConfig` disables the slide
 * under a reduced-motion preference.
 *
 * @param props - Drawer configuration.
 * @returns Backdrop + sliding panel.
 */
function TreeDrawer({ open, onClose, children }: TreeDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useModalChrome(open, onClose, panelRef);

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
            className="fixed inset-0 z-40 bg-black/45"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            key="panel"
            ref={panelRef}
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed left-0 top-[var(--topbar-h)] z-50 flex h-[calc(var(--viewport-height)-var(--topbar-h))] w-[300px] max-w-[85vw] flex-col border-r border-border shadow-[var(--shadow-float)]"
            role="dialog"
            aria-label="Notes tree"
          >
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export default NotesView;
