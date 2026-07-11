"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { CollapsibleRail } from "@/components/shared/CollapsibleRail";
import { Drawer } from "@/components/shared/Drawer";
import { IconPanelLeft, IconSettings } from "@/components/shared/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useMounted } from "@/hooks/useMounted";
import {
  useNotesRailCollapse,
  useNotesSettingsCollapse,
} from "@/hooks/useNotesCollapse";
import {
  type NoteGroupKey,
  type NoteSortKey,
  readNoteGroup,
  readNoteSort,
} from "@/lib/ui/note-order";
import { EditorPane, type TaskSlimMap } from "./EditorPane";
import { SettingsPane } from "./SettingsPane";
import { TreePane } from "./TreePane";
import { useCreateNote } from "./useNoteMutations";

/** Width of the desktop tree rail, in pixels. */
const RAIL_WIDTH = 320;

/** Width of the settings column and drawer, in pixels; fits the feed-mode chip row on one line. */
const SETTINGS_WIDTH = 352;

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
  const mounted = useMounted();

  // A cleared selection closes the drawer for real (render-time state
  // adjustment, not an effect): the drawer only hides on `noteId === null`,
  // and a surviving `settingsOpen` would silently reopen it on the next
  // note selection.
  if (noteId === null && settingsOpen) setSettingsOpen(false);

  // The tree drawer only renders below `lg`; a `treeOpen` surviving an lg
  // resize cycle would make it reappear unprompted when the viewport
  // shrinks again (same render-time pattern as above).
  if (isLg && treeOpen) setTreeOpen(false);

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
        body: "",
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

  const sort = readNoteSort(searchParams.get("nsort"));
  const group = readNoteGroup(searchParams.get("ngroup"));

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const nextQs = next.toString();
      const currentQs = searchParams.toString();
      // Skip when nothing changed, e.g. clicking the already-active option.
      // Each `router.replace` triggers an RSC refetch of the project layout,
      // so eliding no-op replaces avoids unnecessary server work.
      if (nextQs === currentQs) return;
      router.replace(nextQs ? `${pathname}?${nextQs}` : pathname, {
        scroll: false,
      });
    },
    [router, pathname, searchParams],
  );

  const handleSortChange = useCallback(
    (next: NoteSortKey) => {
      updateParam("nsort", next === "title" ? null : next);
    },
    [updateParam],
  );

  const handleGroupChange = useCallback(
    (next: NoteGroupKey) => {
      updateParam("ngroup", next === "folder" ? null : next);
    },
    [updateParam],
  );

  const handleSelect = useCallback(
    (nextNoteId: string | null) => {
      onSelectNote(nextNoteId);
      setTreeOpen(false);
    },
    [onSelectNote],
  );

  const closeTree = useCallback(() => setTreeOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // The viewport media queries resolve to their desktop SSR defaults until
  // the first client paint; hold a neutral placeholder until mount so a
  // narrow viewport never flashes the desktop three-pane layout.
  if (!mounted) return <NotesViewSkeleton />;

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
        <CollapsibleRail open={!collapsed} width={RAIL_WIDTH}>
          <TreePane
            projectId={projectId}
            selectedId={noteId}
            onSelect={handleSelect}
            onNewNote={(folder) => void createAndSelect(folder)}
            createPending={createNote.isPending}
            createError={createError}
            sort={sort}
            group={group}
            onSortChange={handleSortChange}
            onGroupChange={handleGroupChange}
            onCollapse={toggleRail}
          />
        </CollapsibleRail>
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
        {isXl && noteId !== null && (
          <CollapsibleRail open={!settingsCollapsed} width={SETTINGS_WIDTH}>
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
          </CollapsibleRail>
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
          sort={sort}
          group={group}
          onSortChange={handleSortChange}
          onGroupChange={handleGroupChange}
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

/**
 * Full-height placeholder for the first client paint, before the viewport
 * media queries resolve. Prevents the notes view from flashing the desktop
 * three-pane layout on a narrow viewport during hydration.
 *
 * @returns The decorative loading placeholder.
 */
function NotesViewSkeleton() {
  return (
    <div className="flex h-full w-full items-start justify-center">
      <div className="w-full max-w-[760px] px-4 pt-6 sm:px-[34px] sm:pt-8">
        <span className="sr-only">Loading notes</span>
        <div aria-hidden="true" className="flex flex-col gap-3">
          <span className="h-4 w-1/2 animate-pulse rounded bg-surface-hover" />
          {[320, 280, 360, 240].map((width) => (
            <span
              key={width}
              className="h-2 max-w-full animate-pulse rounded bg-surface-hover"
              style={{ width }}
            />
          ))}
        </div>
      </div>
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
 * Slide-out drawer wrapping the notes tree for viewports below `lg`,
 * left-anchored. Backdrop, slide, and dialog chrome come from the shared
 * {@link Drawer}.
 *
 * @param props - Drawer configuration.
 * @returns The tree drawer.
 */
function TreeDrawer({ open, onClose, children }: TreeDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="left"
      width="300px"
      label="Notes tree"
      modal
    >
      {children}
    </Drawer>
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
 * right-anchored to mirror the ribbon's desktop column. Backdrop, slide, and
 * dialog chrome come from the shared {@link Drawer}.
 *
 * @param props - Drawer configuration.
 * @returns The settings drawer.
 */
function SettingsDrawer({ open, onClose, children }: SettingsDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      width={`${SETTINGS_WIDTH}px`}
      label="Note settings"
      modal
    >
      {children}
    </Drawer>
  );
}

export default NotesView;
