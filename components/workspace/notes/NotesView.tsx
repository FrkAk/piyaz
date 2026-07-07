"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconPanelLeft, IconSettings } from "@/components/shared/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useModalChrome } from "@/hooks/useModalChrome";
import {
  useNotesRailCollapse,
  useNotesSettingsCollapse,
} from "@/hooks/useNotesCollapse";
import { EditorPane, type TaskSlimMap } from "./EditorPane";
import { SettingsPane } from "./SettingsPane";
import { TreePane } from "./TreePane";
import { useCreateNote } from "./useNoteMutations";

interface NotesViewProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param projectIdentifier - Owning project identifier for inline task refs. */
  projectIdentifier: string;
  /** @param noteId - Selected note id from the `?note` query param, or null. */
  noteId: string | null;
  /** @param onSelectNote - Write `?note=<id>` (null clears); the selection contract the notes panes call. */
  onSelectNote: (noteId: string | null) => void;
  /** @param onSelectTask - Open a task detail from an editor chip or a ribbon mention. */
  onSelectTask: (taskId: string) => void;
  /** @param taskMap - Project task slim map for inline chip resolution. */
  taskMap: TaskSlimMap;
  /** @param categories - Project category vocabulary for the settings ribbon. */
  categories: string[];
  /** @param projectTags - Deduped project tag vocabulary for the ribbon. */
  projectTags: string[];
}

/**
 * Notes workspace view. At `lg` and up the tree pane sits beside the
 * editor pane and can be collapsed to give the editor full width via the
 * tree header toggle (persisted per {@link useNotesRailCollapse}), with a
 * reopen button over the editor; below `lg` the editor takes the full width
 * and the tree becomes a slide-over drawer opened from the pane header,
 * closed by selecting a note, the close button, backdrop, or Escape. The
 * settings ribbon is an inline column only at `xl` and up (collapse
 * persisted per {@link useNotesSettingsCollapse}); below `xl` it always
 * opens as the overlay drawer so the editor never gets squeezed. Owns
 * the no-modal create flow: New note persists immediately, selects the
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
  taskMap,
  categories,
  projectTags,
}: NotesViewProps) {
  const isLg = useMediaQuery("(min-width: 1024px)", true);
  const isXl = useMediaQuery("(min-width: 1280px)", true);
  const createNote = useCreateNote(projectId);
  const { collapsed, toggle: toggleRail } = useNotesRailCollapse();
  const { collapsed: settingsCollapsed, toggle: toggleSettings } =
    useNotesSettingsCollapse();
  const [treeOpen, setTreeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // A cleared selection closes the drawer for real (render-time state
  // adjustment, not an effect): the drawer only hides on `noteId === null`,
  // and a surviving `settingsOpen` would silently reopen it on the next
  // note selection.
  if (noteId === null && settingsOpen) setSettingsOpen(false);

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
    (nextNoteId: string | null) => {
      onSelectNote(nextNoteId);
      setTreeOpen(false);
    },
    [onSelectNote],
  );

  const closeTree = useCallback(() => setTreeOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const editor = (
    <EditorPane
      projectId={projectId}
      projectIdentifier={projectIdentifier}
      noteId={noteId}
      focusTitle={focusTitle}
      onFocusedTitle={handleFocusedTitle}
      onSelectTask={onSelectTask}
      onSelectNote={onSelectNote}
      taskMap={taskMap}
    />
  );

  if (isLg) {
    return (
      <div className="flex h-full w-full">
        {!collapsed && (
          <TreePane
            projectId={projectId}
            selectedId={noteId}
            onSelect={handleSelect}
            onNewNote={(folder) => void createAndSelect(folder)}
            createPending={createNote.isPending}
            createError={createError}
            onCollapse={toggleRail}
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {collapsed && (
            <button
              type="button"
              onClick={toggleRail}
              aria-label="Show notes list"
              title="Show notes list"
              className="absolute left-2 top-2 z-10 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border-strong bg-base text-text-muted hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              <IconPanelLeft size={13} />
            </button>
          )}
          {noteId !== null && (!isXl || settingsCollapsed) && (
            <button
              type="button"
              onClick={isXl ? toggleSettings : () => setSettingsOpen(true)}
              aria-label="Show settings"
              title="Show settings"
              className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border-strong bg-base text-text-muted hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              <IconSettings size={13} />
            </button>
          )}
          {editor}
        </div>
        {isXl && noteId !== null && !settingsCollapsed && (
          <SettingsPane
            key={noteId}
            projectId={projectId}
            noteId={noteId}
            categories={categories}
            projectTags={projectTags}
            taskMap={taskMap}
            onSelectNote={onSelectNote}
            onSelectTask={onSelectTask}
            onCollapse={toggleSettings}
          />
        )}
        {!isXl && (
          <SettingsDrawer
            open={noteId !== null && settingsOpen}
            onClose={closeSettings}
          >
            {noteId !== null && (
              <SettingsPane
                key={noteId}
                fill
                projectId={projectId}
                noteId={noteId}
                categories={categories}
                projectTags={projectTags}
                taskMap={taskMap}
                onSelectNote={onSelectNote}
                onSelectTask={onSelectTask}
                onClose={closeSettings}
              />
            )}
          </SettingsDrawer>
        )}
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
        {noteId !== null && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Note settings"
            title="Note settings"
            className="ml-auto inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <IconSettings size={15} />
          </button>
        )}
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
      <SettingsDrawer
        open={noteId !== null && settingsOpen}
        onClose={closeSettings}
      >
        {noteId !== null && (
          <SettingsPane
            key={noteId}
            fill
            projectId={projectId}
            noteId={noteId}
            categories={categories}
            projectTags={projectTags}
            taskMap={taskMap}
            onSelectNote={onSelectNote}
            onSelectTask={onSelectTask}
            onClose={closeSettings}
          />
        )}
      </SettingsDrawer>
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

interface SettingsDrawerProps {
  /** @param open - Whether the drawer is open. */
  open: boolean;
  /** @param onClose - Close the drawer. */
  onClose: () => void;
  /** @param children - Drawer body, the fill-mode settings ribbon. */
  children: React.ReactNode;
}

/**
 * Slide-out drawer wrapping the settings ribbon for viewports below `xl`,
 * anchored to the right to mirror the ribbon's desktop column. Closes on
 * backdrop click and on Esc. Dialog chrome (Escape via the shared modal
 * stack, Tab focus trap, focus seed and restore) comes from
 * {@link useModalChrome}; the global `MotionConfig` disables the slide under
 * a reduced-motion preference.
 *
 * @param props - Drawer configuration.
 * @returns Backdrop + sliding panel.
 */
function SettingsDrawer({ open, onClose, children }: SettingsDrawerProps) {
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
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed right-0 top-[var(--topbar-h)] z-50 flex h-[calc(var(--viewport-height)-var(--topbar-h))] w-[320px] max-w-[85vw] flex-col border-l border-border shadow-[var(--shadow-float)]"
            role="dialog"
            aria-label="Note settings"
          >
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export default NotesView;
