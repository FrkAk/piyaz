"use client";

import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  IconChevronDown,
  IconChevronRight,
  IconDoc,
  IconFolderPlus,
  IconGrip,
  IconLock,
  IconMore,
  IconPanelLeft,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUser,
  IconX,
} from "@/components/shared/icons";
import { Dropdown } from "@/components/shared/Dropdown";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useUndo, UndoButton } from "@/hooks/useUndo";
import type { NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  fetchNoteFolders,
  fetchNoteSearch,
  fetchNotesTree,
} from "@/lib/query/queries";
import { DeleteConfirm } from "@/components/workspace/structure/DeleteConfirm";
import { ConfirmDialog } from "./ConfirmDialog";
import { MoveToFolderDialog } from "./MoveToFolderDialog";
import {
  type FolderMovePlan,
  leafOf,
  normalizeFolderInput,
  NOTE_TYPE_META,
  parentOf,
  planFolderMove,
  planFolderRename,
  resolveCreateTarget,
  tint,
  type TypeFilter,
} from "./note-meta";
import {
  useCreateFolder,
  useDeleteFolder,
  useDeleteNote,
  useMoveFolder,
  useMoveNote,
  useRestoreNote,
  useUpdateNote,
} from "./useNoteMutations";

/** Debounce window between a keystroke and the server search request. */
const SEARCH_DEBOUNCE_MS = 250;

/** Type-filter chip order. */
const CHIPS: TypeFilter[] = ["all", "reference", "guidance", "knowledge"];

/** Fixed tree-rail width in px at `lg`. */
const RAIL_WIDTH = 320;

interface TreePaneProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param selectedId - Selected note id, or null. */
  selectedId: string | null;
  /** @param onSelect - Select a note (writes `?note=<id>`); null clears the selection. */
  onSelect: (noteId: string | null) => void;
  /** @param onNewNote - Create a note in the given folder. */
  onNewNote: (folder: string) => void;
  /** @param createPending - Disables the New note button while a create is in flight. */
  createPending: boolean;
  /** @param createError - Failure message from the last note create, or null. */
  createError: string | null;
  /** @param fill - Fill the parent instead of the fixed-width rail (drawer mode). */
  fill?: boolean;
  /** @param onClose - When set, renders a close button in the header (drawer mode). */
  onClose?: () => void;
  /** @param onCollapse - When set, renders a rail-collapse toggle in the header (`lg` rail mode). */
  onCollapse?: () => void;
}

type DragItem = { kind: "note" | "folder"; id: string };

interface NoteRowProps {
  row: NoteTreeRow;
  indent: number;
  active: boolean;
  dragging: boolean;
  dropTarget?: boolean;
  onSelect: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent<HTMLButtonElement>) => void;
  onDrop?: (e: DragEvent<HTMLButtonElement>) => void;
  renaming?: boolean;
  renameValue?: string;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  onBeginRename?: () => void;
  onDelete?: () => void;
  armed?: boolean;
  onArmDelete?: () => void;
  onCancelDelete?: () => void;
  coarse?: boolean;
  onMove?: () => void;
}

/** Row action-menu option values. */
type RowAction = "rename" | "move" | "delete";

/** Action-menu options shared by note and folder rows on touch. */
const ROW_ACTION_OPTIONS: { value: RowAction; label: string }[] = [
  { value: "rename", label: "Rename" },
  { value: "move", label: "Move to folder…" },
  { value: "delete", label: "Delete" },
];

interface RowActionsMenuProps {
  /** @param label - Accessible label for the trigger. */
  label: string;
  /** @param onRename - Enter inline rename. */
  onRename: () => void;
  /** @param onMove - Open the move-to-folder picker. */
  onMove: () => void;
  /** @param onDelete - Arm or open the delete confirm. */
  onDelete: () => void;
}

/**
 * Touch overflow menu in a row's trailing slot: Rename, Move, Delete. The
 * only reorganize path on coarse pointers, where native drag never fires.
 *
 * @param props - Accessible label and action handlers.
 * @returns The anchored `⋯` action menu.
 */
function RowActionsMenu({
  label,
  onRename,
  onMove,
  onDelete,
}: RowActionsMenuProps) {
  return (
    <span className="absolute right-1 top-1/2 -translate-y-1/2">
      <Dropdown<string>
        value=""
        options={ROW_ACTION_OPTIONS}
        align="end"
        minWidth={150}
        ariaLabel={label}
        onChange={(v) => {
          if (v === "rename") onRename();
          else if (v === "move") onMove();
          else onDelete();
        }}
        renderTrigger={() => (
          <span className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary">
            <IconMore size={14} />
          </span>
        )}
      />
    </span>
  );
}

/**
 * One note row, shared between the folder tree and the flat search-hit
 * list. Draggable only when drag handlers are wired (tree mode). In tree
 * mode double-click or F2 opens the inline rename input and a hover trash
 * deletes the note; the search-hit list wires neither.
 *
 * @param props - Row data, indentation, selection state, and handlers.
 * @returns The note row, or its inline rename input while renaming.
 */
function NoteRow({
  row,
  indent,
  active,
  dragging,
  dropTarget = false,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  renaming = false,
  renameValue = "",
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onBeginRename,
  onDelete,
  armed = false,
  onArmDelete,
  onCancelDelete,
  coarse = false,
  onMove,
}: NoteRowProps) {
  const color = NOTE_TYPE_META[row.type].color;
  const draggable = onDragStart !== undefined;

  if (renaming) {
    return (
      <div
        className="flex w-full items-center gap-2 rounded-md pr-2"
        style={{ height: 30, paddingLeft: indent + 16 }}
      >
        <IconDoc size={13} style={{ color }} />
        <RenameInput
          value={renameValue}
          onChange={(value) => onRenameChange?.(value)}
          onCommit={() => onRenameCommit?.()}
          onCancel={() => onRenameCancel?.()}
          ariaLabel="Note name"
        />
      </div>
    );
  }

  return (
    <div className="group relative flex w-full items-center">
      <button
        type="button"
        draggable={draggable}
        aria-roledescription={draggable ? "Draggable note" : undefined}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={onSelect}
        onDoubleClick={onBeginRename}
        onKeyDown={
          onBeginRename === undefined
            ? undefined
            : (e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  onBeginRename();
                }
              }
        }
        className="relative flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left"
        style={{
          height: 30,
          paddingLeft: indent + 16,
          paddingRight: onDelete === undefined ? 8 : 30,
          opacity: dragging ? 0.45 : 1,
          background: dropTarget
            ? tint("var(--color-accent)", 14)
            : active
              ? tint("var(--color-accent)", 7)
              : "transparent",
          outline: dropTarget ? "1px solid var(--color-accent)" : undefined,
        }}
      >
        {active && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 4,
              top: 5,
              bottom: 5,
              width: 2,
              borderRadius: 2,
              background: color,
            }}
          />
        )}
        <span className="text-text-faint opacity-0 pointer-fine:group-hover:opacity-100">
          <IconGrip size={11} />
        </span>
        <IconDoc size={13} style={{ color }} />
        <span
          className="min-w-0 flex-1 truncate text-[12.5px]"
          style={{
            fontWeight: active ? 600 : 500,
            fontStyle: row.title ? "normal" : "italic",
            color: active
              ? "var(--color-text-primary)"
              : row.title
                ? "var(--color-text-secondary)"
                : "var(--color-text-faint)",
          }}
        >
          {row.title || "Untitled"}
        </span>
        {row.visibility === "private" && (
          <IconUser size={10} className="text-text-faint" />
        )}
        {!row.agentWritable && (
          <IconLock size={10} className="text-text-faint" />
        )}
      </button>
      {onDelete !== undefined &&
        (armed ? (
          <span
            className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded px-0.5"
            style={{ background: "var(--color-base-2)" }}
          >
            <DeleteConfirm
              onConfirm={onDelete}
              onCancel={() => onCancelDelete?.()}
            />
          </span>
        ) : coarse ? (
          <RowActionsMenu
            label="Note actions"
            onRename={() => onBeginRename?.()}
            onMove={() => onMove?.()}
            onDelete={() => onArmDelete?.()}
          />
        ) : (
          <button
            type="button"
            onClick={() => onArmDelete?.()}
            aria-label="Delete note"
            title="Delete note"
            className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-text-muted opacity-0 transition-all hover:bg-surface-hover hover:text-danger group-hover:opacity-100"
          >
            <IconTrash size={11} />
          </button>
        ))}
    </div>
  );
}

interface RenameInputProps {
  /** @param value - Current draft name. */
  value: string;
  /** @param onChange - Draft name change. */
  onChange: (value: string) => void;
  /** @param onCommit - Commit the rename (Enter or blur). */
  onCommit: () => void;
  /** @param onCancel - Cancel the rename (Escape). */
  onCancel: () => void;
  /** @param ariaLabel - Accessible label for the field. */
  ariaLabel: string;
}

/**
 * Inline rename field, swapped in for a folder or note label. Focuses and
 * selects its content on mount; Enter and blur commit, Escape cancels.
 *
 * @param props - Draft value, commit/cancel wiring, and accessible label.
 * @returns The rename input.
 */
function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
}: RenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      aria-label={ariaLabel}
      className="min-w-0 flex-1 rounded px-1 text-[12px] font-semibold outline-none"
      style={{
        height: 20,
        color: "var(--color-text-primary)",
        border: "1px solid var(--color-accent)",
        background: "var(--color-surface)",
      }}
    />
  );
}

/** Tree-shaped skeleton rows: two folders with nested and root files. */
const SKELETON_ROWS: { height: number; indent: number; bar: number }[] = [
  { height: 26, indent: 8, bar: 96 },
  { height: 30, indent: 24, bar: 124 },
  { height: 30, indent: 24, bar: 88 },
  { height: 26, indent: 8, bar: 72 },
  { height: 30, indent: 24, bar: 108 },
  { height: 30, indent: 8, bar: 136 },
];

/**
 * Pulsing placeholder mirroring the folder tree while the list loads,
 * matching the locked folder (26) and note (30) row heights so the real
 * rows swap in without a layout shift.
 *
 * @returns The decorative skeleton column.
 */
function TreeSkeleton() {
  return (
    <div className="pt-1">
      <span className="sr-only">Loading notes</span>
      {SKELETON_ROWS.map((row, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex items-center gap-2"
          style={{ height: row.height, paddingLeft: row.indent }}
        >
          <span className="h-3 w-3 shrink-0 animate-pulse rounded bg-surface-hover" />
          <span
            className="h-2 animate-pulse rounded bg-surface-hover"
            style={{ width: row.bar }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Left pane, searchable nested folder tree with drag-and-drop and inline
 * actions, backed by the notes tree list, the explicit-folders list, and
 * the server search route. Folders are path prefixes on note rows plus
 * explicit `note_folders` marker rows for empty folders, so a created
 * folder survives reload. New folders are naming-first: the button opens
 * an inline name input and the folder persists on commit. Clicking a
 * folder toggles collapse and selects it as the New-note create target
 * (accent-tinted, `aria-current`); selecting a note clears the folder
 * selection. Folder and note rows rename inline (double-click or F2) and
 * delete via a hover trash that arms a two-step inline confirm: a note
 * deletes with an Undo entry, an empty folder deletes its marker rows,
 * and a non-empty folder instead opens a bulk modal then deletes its
 * notes as one undoable entry. Tree mutation failures surface in a strip
 * above the list. On fine pointers notes and folders reorder by native
 * drag-and-drop (which never fires on touch); on coarse pointers a
 * per-row overflow menu exposes Rename, Move to folder, and Delete, with
 * Move opening a folder picker so touch users can reorganize. A
 * keyboard-accessible move affordance is still deferred to a follow-up.
 *
 * @param props - Project scope, selection state, create wiring, and drawer-mode flags.
 * @returns The fixed-width tree column, or a parent-filling column in drawer mode.
 */
export function TreePane({
  projectId,
  selectedId,
  onSelect,
  onNewNote,
  createPending,
  createError,
  fill = false,
  onClose,
  onCollapse,
}: TreePaneProps) {
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [dropRowId, setDropRowId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{
    path: string;
    value: string;
  } | null>(null);
  const [renamingNote, setRenamingNote] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<{
    path: string;
    noteIds: string[];
  } | null>(null);
  const [armedDelete, setArmedDelete] = useState<{
    kind: "note" | "folder";
    id: string;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    kind: "note" | "folder";
    id: string;
    currentPath: string;
  } | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const coarse = useMediaQuery("(pointer: coarse)");

  const list = useQuery({
    queryKey: noteKeys.list(projectId),
    queryFn: fetchNotesTree(qc, projectId),
  });
  const rows = list.data;

  const folders = useQuery({
    queryKey: noteKeys.folders(projectId),
    queryFn: fetchNoteFolders(qc, projectId),
  });

  const [prevSelectedId, setPrevSelectedId] = useState(selectedId);
  if (prevSelectedId !== selectedId) {
    setPrevSelectedId(selectedId);
    if (selectedId !== null) setSelectedFolder(null);
  }

  useEffect(() => {
    const trimmed = rawQuery.trim();
    const id = setTimeout(
      () => setDebouncedQuery(trimmed),
      trimmed === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [rawQuery]);

  const query = rawQuery.trim() === "" ? "" : debouncedQuery;
  const searching = query !== "";
  const search = useQuery({
    queryKey: noteKeys.search(projectId, query),
    queryFn: fetchNoteSearch(projectId, query),
    enabled: searching,
    placeholderData: keepPreviousData,
  });

  const moveNote = useMoveNote(projectId);
  const moveFolder = useMoveFolder(projectId);
  const updateNote = useUpdateNote(projectId);
  const deleteNote = useDeleteNote(projectId);
  const restoreNote = useRestoreNote(projectId);
  const createFolder = useCreateFolder(projectId);
  const deleteFolder = useDeleteFolder(projectId);

  const {
    canUndo,
    push: pushUndo,
    undo,
  } = useUndo<{ noteIds: string[]; label: string }>({
    onUndo: async (item) => {
      for (const id of item.noteIds) {
        const result = await restoreNote.mutateAsync(id);
        if (!result.ok) throw new Error(result.message);
      }
    },
    resetOn: projectId,
    keyboard: true,
  });

  const visibleRows = useMemo(() => {
    const all = rows ?? [];
    return typeFilter === "all"
      ? all
      : all.filter((r) => r.type === typeFilter);
  }, [rows, typeFilter]);

  const allFolders = useMemo(() => {
    const set = new Set<string>(folders.data ?? []);
    for (const r of rows ?? []) if (r.folder) set.add(r.folder);
    for (const f of [...set]) {
      const parts = f.split("/");
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        set.add(acc);
      }
    }
    return [...set].sort();
  }, [rows, folders.data]);

  const notesByFolder = useMemo(() => {
    const map = new Map<string, NoteTreeRow[]>();
    for (const r of visibleRows) {
      const bucket = map.get(r.folder);
      if (bucket) bucket.push(r);
      else map.set(r.folder, [r]);
    }
    return map;
  }, [visibleRows]);

  const hits = useMemo(() => {
    const all = search.data ?? [];
    return typeFilter === "all"
      ? all
      : all.filter((h) => h.type === typeFilter);
  }, [search.data, typeFilter]);

  const count = searching ? hits.length : visibleRows.length;

  /** Toggle a folder's collapsed state. */
  function toggle(path: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Clear the in-flight drag state. */
  function clearDrag() {
    setDrag(null);
    setDropFolder(null);
    setDropRowId(null);
  }

  /** Open the naming-first inline input for a new root folder. */
  function handleNewFolder() {
    setTreeError(null);
    setRawQuery("");
    setCreatingFolder("");
  }

  /**
   * Commit the naming-first folder create. An empty input cancels; an
   * existing path just selects that folder; otherwise the folder
   * persists server-side and becomes the selected create target.
   */
  function commitNewFolder() {
    const draft = creatingFolder;
    if (draft === null) return;
    setCreatingFolder(null);
    const path = normalizeFolderInput(draft);
    if (path === "") return;
    setSelectedFolder(path);
    if (allFolders.includes(path)) return;
    createFolder.mutate(path, {
      onSuccess: (result) => {
        if (!result.ok) setTreeError(result.message);
      },
      onError: () => setTreeError("Folder create failed"),
    });
  }

  /** Create a note in the selected folder, the selected note's folder, or Drafts. */
  function handleNewNote() {
    const selectedRow = selectedId
      ? (rows ?? []).find((r) => r.id === selectedId)
      : undefined;
    onNewNote(resolveCreateTarget(selectedFolder, selectedRow?.folder));
  }

  /**
   * Select a note row, clearing the folder create-target selection even
   * when the note is already selected (the selection sync only fires on
   * a changed id).
   *
   * @param noteId - Clicked note id.
   */
  function selectNote(noteId: string) {
    setSelectedFolder(null);
    onSelect(noteId);
  }

  /**
   * Rewrite client-local state keyed by folder path (collapsed entries
   * and the selected folder) under a moved prefix.
   *
   * @param src - Source folder path.
   * @param dest - Destination folder path.
   */
  function rewriteLocalPaths(src: string, dest: string) {
    const rewrite = (f: string) =>
      f === src || f.startsWith(`${src}/`) ? dest + f.slice(src.length) : f;
    setCollapsed((c) => new Set([...c].map(rewrite)));
    setSelectedFolder((s) => (s === null ? s : rewrite(s)));
  }

  /**
   * Clear the selected folder when it sits at or under a deleted path.
   *
   * @param path - Deleted folder path.
   */
  function clearSelectionUnder(path: string) {
    setSelectedFolder((s) =>
      s !== null && (s === path || s.startsWith(`${path}/`)) ? null : s,
    );
  }

  /**
   * Dispatch a folder mutation plan from rename or drag re-parent.
   * Collisions surface in the error strip without dispatching (no
   * silent merge). The whole subtree re-parents server-side via
   * `moveFolder`, which also rewrites explicit empty-folder rows, so an
   * empty folder's rename or move survives a reload.
   *
   * @param src - Folder path being moved or renamed.
   * @param plan - Plan from {@link planFolderRename} or {@link planFolderMove}.
   */
  function applyFolderPlan(src: string, plan: FolderMovePlan) {
    if (plan.kind === "noop") return;
    if (plan.kind === "collision") {
      setTreeError(`Folder "${plan.dest}" already exists`);
      return;
    }
    moveFolder.mutate(
      { src, destParent: plan.destParent, leaf: plan.leaf },
      {
        onSuccess: (result) => {
          if (result.ok) rewriteLocalPaths(src, result.data.dest);
          else setTreeError(result.message);
        },
        onError: () => setTreeError("Folder move failed"),
      },
    );
  }

  /**
   * Complete a drop onto a folder, moving the dragged note or folder.
   * Self/descendant folder drops and no-op moves never dispatch;
   * collisions and failures surface in the tree error strip.
   *
   * @param path - Target folder path.
   */
  function dropOnto(path: string) {
    const item = drag;
    clearDrag();
    if (!item) return;
    setTreeError(null);
    if (item.kind === "note") {
      const row = (rows ?? []).find((r) => r.id === item.id);
      if (!row || row.folder === path) return;
      moveNote.mutate(
        { noteId: item.id, folder: path },
        {
          onSuccess: (result) => {
            if (!result.ok) setTreeError(result.message);
          },
          onError: () => setTreeError("Move failed"),
        },
      );
      return;
    }
    applyFolderPlan(item.id, planFolderMove(item.id, path, allFolders));
  }

  /**
   * Enter inline rename mode on a folder row.
   *
   * @param path - Folder path to rename.
   */
  function beginRename(path: string) {
    setTreeError(null);
    setRenaming({ path, value: leafOf(path) });
  }

  /** Commit the in-flight rename through {@link applyFolderPlan}. */
  function commitRename() {
    const r = renaming;
    if (!r) return;
    setRenaming(null);
    applyFolderPlan(r.path, planFolderRename(r.path, r.value, allFolders));
  }

  /**
   * Enter inline rename mode on a note row.
   *
   * @param row - Note row to rename.
   */
  function beginRenameNote(row: NoteTreeRow) {
    setTreeError(null);
    setRenamingNote({ id: row.id, value: row.title });
  }

  /**
   * Commit the in-flight note rename. A blank or unchanged title is a
   * no-op; a real change patches the title, which re-slugs a still-
   * untitled note server-side.
   */
  function commitRenameNote() {
    const r = renamingNote;
    if (r === null) return;
    setRenamingNote(null);
    const row = (rows ?? []).find((x) => x.id === r.id);
    const next = r.value.trim();
    if (row === undefined || next === "" || next === row.title) return;
    updateNote.mutate({ noteId: r.id, patch: { title: next } });
  }

  /**
   * Soft-delete a note and push a single-note undo entry.
   *
   * @param row - Note row to delete.
   */
  function handleDeleteNote(row: NoteTreeRow) {
    setTreeError(null);
    if (row.id === selectedId) onSelect(null);
    deleteNote.mutate(row.id, {
      onSuccess: (result) => {
        if (result.ok) {
          pushUndo({ noteIds: [row.id], label: row.title || "Untitled" });
        } else {
          setTreeError(result.message);
        }
      },
      onError: () => setTreeError("Delete failed"),
    });
  }

  /**
   * Every server note id at or under a folder path.
   *
   * @param path - Folder path.
   * @returns Ids of notes in the folder subtree.
   */
  function noteIdsUnder(path: string): string[] {
    return (rows ?? [])
      .filter((r) => r.folder === path || r.folder.startsWith(`${path}/`))
      .map((r) => r.id);
  }

  /**
   * Delete a folder. An empty client-local folder arms the inline
   * two-step confirm; a folder holding notes opens the bulk modal.
   *
   * @param path - Folder path to delete.
   */
  function handleDeleteFolder(path: string) {
    setTreeError(null);
    const ids = noteIdsUnder(path);
    if (ids.length === 0) {
      setArmedDelete({ kind: "folder", id: path });
      return;
    }
    setPendingFolderDelete({ path, noteIds: ids });
  }

  /**
   * Delete an empty folder's explicit rows server-side and disarm.
   *
   * @param path - Folder path to remove.
   */
  function dropEmptyFolder(path: string) {
    setArmedDelete(null);
    clearSelectionUnder(path);
    deleteFolder.mutate(path, {
      onSuccess: (result) => {
        if (!result.ok) setTreeError(result.message);
      },
      onError: () => setTreeError("Delete failed"),
    });
  }

  /**
   * Confirm a non-empty folder delete: clear the selection when the open
   * note is inside, drop the subtree's explicit folder rows, await the
   * soft-delete of every note under the folder, then push one undo entry
   * that restores the notes (explicit empty subfolders are not
   * resurrected by the undo).
   */
  async function confirmFolderDelete() {
    const pending = pendingFolderDelete;
    setPendingFolderDelete(null);
    if (pending === null) return;
    if (selectedId !== null && pending.noteIds.includes(selectedId)) {
      onSelect(null);
    }
    clearSelectionUnder(pending.path);
    deleteFolder.mutate(pending.path, {
      onSuccess: (result) => {
        if (!result.ok) setTreeError(result.message);
      },
      onError: () => setTreeError("Delete failed"),
    });
    const results = await Promise.all(
      pending.noteIds.map((id) => deleteNote.mutateAsync(id).catch(() => null)),
    );
    for (const result of results) {
      if (result === null) setTreeError("Delete failed");
      else if (!result.ok) setTreeError(result.message);
    }
    pushUndo({ noteIds: pending.noteIds, label: leafOf(pending.path) });
  }

  /**
   * Apply the pending touch move to the chosen destination. A note moves
   * folders; a folder re-parents through {@link applyFolderPlan}.
   *
   * @param dest - Destination folder path (`""` = root).
   */
  function applyMove(dest: string) {
    const target = moveTarget;
    setMoveTarget(null);
    if (target === null) return;
    setTreeError(null);
    if (target.kind === "note") {
      moveNote.mutate(
        { noteId: target.id, folder: dest },
        {
          onSuccess: (result) => {
            if (!result.ok) setTreeError(result.message);
          },
          onError: () => setTreeError("Move failed"),
        },
      );
      return;
    }
    applyFolderPlan(target.id, planFolderMove(target.id, dest, allFolders));
  }

  /**
   * Recursively render a folder, its child folders, and its notes.
   *
   * @param path - Folder path.
   * @param depth - Nesting depth, drives indentation.
   * @returns The folder branch.
   */
  function renderFolder(path: string, depth: number): ReactNode {
    const folderNotes = notesByFolder.get(path) ?? [];
    const subFolders = allFolders.filter((f) => parentOf(f) === path);
    const isCollapsed = collapsed.has(path);
    const isDropTarget = dropFolder === path;
    const isSelected = selectedFolder === path;
    const indent = 8 + depth * 12;
    return (
      <div key={path}>
        {renaming?.path === path ? (
          <div
            className="flex w-full items-center gap-1 rounded-md pr-2 text-text-secondary"
            style={{ height: 26, paddingLeft: indent }}
          >
            {isCollapsed ? (
              <IconChevronRight size={11} className="text-text-muted" />
            ) : (
              <IconChevronDown size={11} className="text-text-muted" />
            )}
            <RenameInput
              value={renaming.value}
              onChange={(value) => setRenaming({ path, value })}
              onCommit={commitRename}
              onCancel={() => setRenaming(null)}
              ariaLabel="Folder name"
            />
          </div>
        ) : (
          <div className="group relative flex w-full items-center">
            <button
              type="button"
              draggable
              aria-roledescription="Draggable folder"
              aria-current={isSelected ? "true" : undefined}
              onClick={() => {
                toggle(path);
                setSelectedFolder(path);
              }}
              onDoubleClick={() => beginRename(path)}
              onKeyDown={(e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  beginRename(path);
                }
              }}
              onDragStart={(e) => {
                e.stopPropagation();
                setDrag({ kind: "folder", id: path });
              }}
              onDragEnd={clearDrag}
              onDragOver={(e) => {
                e.preventDefault();
                setDropFolder(path);
                setDropRowId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dropOnto(path);
              }}
              className="relative flex min-w-0 flex-1 items-center gap-1 rounded-md text-left"
              style={{
                height: 26,
                paddingLeft: indent,
                paddingRight: 30,
                opacity: drag?.kind === "folder" && drag.id === path ? 0.45 : 1,
                color: isSelected
                  ? "var(--color-text-primary)"
                  : "var(--color-text-secondary)",
                background: isDropTarget
                  ? tint("var(--color-accent)", 14)
                  : isSelected
                    ? tint("var(--color-accent)", 7)
                    : "transparent",
                outline: isDropTarget
                  ? "1px solid var(--color-accent)"
                  : "1px solid transparent",
              }}
            >
              {isSelected && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: 4,
                    top: 4,
                    bottom: 4,
                    width: 2,
                    borderRadius: 2,
                    background: "var(--color-accent)",
                  }}
                />
              )}
              {isCollapsed ? (
                <IconChevronRight size={11} className="text-text-muted" />
              ) : (
                <IconChevronDown size={11} className="text-text-muted" />
              )}
              <span className="text-[12px] font-semibold">{leafOf(path)}</span>
              <span className="ml-auto font-mono text-[10px] text-text-faint">
                {folderNotes.length}
              </span>
            </button>
            {armedDelete?.kind === "folder" && armedDelete.id === path ? (
              <span
                className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded px-0.5"
                style={{ background: "var(--color-base-2)" }}
              >
                <DeleteConfirm
                  onConfirm={() => dropEmptyFolder(path)}
                  onCancel={() => setArmedDelete(null)}
                />
              </span>
            ) : coarse ? (
              <RowActionsMenu
                label="Folder actions"
                onRename={() => beginRename(path)}
                onMove={() =>
                  setMoveTarget({
                    kind: "folder",
                    id: path,
                    currentPath: parentOf(path),
                  })
                }
                onDelete={() => handleDeleteFolder(path)}
              />
            ) : (
              <button
                type="button"
                onClick={() => handleDeleteFolder(path)}
                aria-label="Delete folder"
                title="Delete folder"
                className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-text-muted opacity-0 transition-all hover:bg-surface-hover hover:text-danger group-hover:opacity-100"
              >
                <IconTrash size={11} />
              </button>
            )}
          </div>
        )}
        {!isCollapsed && (
          <>
            {subFolders.map((s) => renderFolder(s, depth + 1))}
            {folderNotes.map((n) => (
              <NoteRow
                key={n.id}
                row={n}
                indent={indent}
                active={n.id === selectedId}
                dragging={drag?.kind === "note" && drag.id === n.id}
                dropTarget={drag !== null && dropRowId === n.id}
                onSelect={() => selectNote(n.id)}
                onDragStart={() => setDrag({ kind: "note", id: n.id })}
                onDragEnd={clearDrag}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropFolder(n.folder);
                  setDropRowId(n.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnto(n.folder);
                }}
                renaming={renamingNote?.id === n.id}
                renameValue={
                  renamingNote !== null && renamingNote.id === n.id
                    ? renamingNote.value
                    : ""
                }
                onRenameChange={(value) => setRenamingNote({ id: n.id, value })}
                onRenameCommit={commitRenameNote}
                onRenameCancel={() => setRenamingNote(null)}
                onBeginRename={() => beginRenameNote(n)}
                onDelete={() => {
                  handleDeleteNote(n);
                  setArmedDelete(null);
                }}
                armed={armedDelete?.kind === "note" && armedDelete.id === n.id}
                onArmDelete={() => setArmedDelete({ kind: "note", id: n.id })}
                onCancelDelete={() => setArmedDelete(null)}
                coarse={coarse}
                onMove={() =>
                  setMoveTarget({
                    kind: "note",
                    id: n.id,
                    currentPath: n.folder,
                  })
                }
              />
            ))}
          </>
        )}
      </div>
    );
  }

  const roots = allFolders.filter((f) => parentOf(f) === "");
  const rootNotes = notesByFolder.get("") ?? [];
  const foldersError = folders.isError ? "Failed to load folders" : null;

  return (
    <div
      className={
        fill ? "flex h-full w-full flex-col" : "flex shrink-0 flex-col"
      }
      style={{
        width: fill ? undefined : RAIL_WIDTH,
        background: "var(--color-base-2)",
        borderRight: fill ? undefined : "1px solid var(--color-border)",
      }}
    >
      <div
        className="flex items-center justify-between px-3"
        style={{ height: 40 }}
      >
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Notes · {count}
        </span>
        <div className="flex items-center gap-0.5">
          <UndoButton canUndo={canUndo} onUndo={undo} className="mr-0.5" />
          <button
            type="button"
            onClick={handleNewFolder}
            aria-label="New folder"
            title="New folder"
            className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <IconFolderPlus size={13} />
          </button>
          <button
            type="button"
            onClick={handleNewNote}
            disabled={createPending}
            aria-label="New note"
            title="New note"
            className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary disabled:cursor-default disabled:opacity-50"
          >
            <IconPlus size={13} />
          </button>
          {onCollapse !== undefined && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Hide notes list"
              title="Hide notes list"
              className="ml-0.5 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
            >
              <IconPanelLeft size={13} />
            </button>
          )}
          {onClose !== undefined && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close notes tree"
              title="Close notes tree"
              className="ml-0.5 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
            >
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="px-3 pb-2">
        <div
          className="flex items-center gap-1.5 rounded-md px-2 focus-within:ring-1 focus-within:ring-[color:var(--color-accent)]"
          style={{
            height: 28,
            border: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <IconSearch size={12} className="shrink-0 text-text-faint" />
          <input
            type="search"
            aria-label="Search notes"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRawQuery("");
            }}
            placeholder="Search notes…"
            className="w-full bg-transparent font-mono text-[11.5px] outline-none placeholder:text-text-faint [&::-webkit-search-cancel-button]:appearance-none"
            style={{ color: "var(--color-text-secondary)" }}
          />
          {rawQuery !== "" && (
            <button
              type="button"
              onClick={() => setRawQuery("")}
              aria-label="Clear search"
              title="Clear search"
              className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-text-faint hover:text-text-primary"
            >
              <IconX size={11} />
            </button>
          )}
        </div>
        <p className="mt-1 px-0.5 font-mono text-[9.5px] text-text-faint">
          Same index agents query via piyaz_note search
        </p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CHIPS.map((c) => {
          const active = typeFilter === c;
          const color =
            c === "all" ? "var(--color-accent)" : NOTE_TYPE_META[c].color;
          const labelColor =
            c === "all" && !active ? "var(--color-text-muted)" : color;
          return (
            <button
              key={c}
              type="button"
              aria-pressed={active}
              onClick={() => setTypeFilter(c)}
              className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
              style={{
                color: labelColor,
                background: active ? tint(color, 13) : "transparent",
                border: `1px solid ${active ? tint(color, 30) : "var(--color-border)"}`,
              }}
            >
              {c === "all" ? "All" : NOTE_TYPE_META[c].label}
            </button>
          );
        })}
      </div>

      {(treeError ?? createError ?? foldersError) !== null && (
        <p
          className="px-3 pb-1.5 font-mono text-[10.5px]"
          style={{ color: "var(--color-danger)" }}
        >
          {treeError ?? createError ?? foldersError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {searching ? (
          search.isError ? (
            <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
              Search failed
            </p>
          ) : hits.length > 0 ? (
            hits.map((h) => (
              <NoteRow
                key={h.id}
                row={h}
                indent={8}
                active={h.id === selectedId}
                dragging={false}
                onSelect={() => selectNote(h.id)}
              />
            ))
          ) : search.isPending ? (
            <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
              Searching…
            </p>
          ) : (
            <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
              No matches
            </p>
          )
        ) : list.isError ? (
          <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
            Failed to load notes
          </p>
        ) : list.isPending ? (
          <TreeSkeleton />
        ) : roots.length === 0 &&
          rootNotes.length === 0 &&
          creatingFolder === null ? (
          <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
            No notes yet
          </p>
        ) : (
          <>
            {creatingFolder !== null && (
              <div
                className="flex w-full items-center gap-1 rounded-md pr-2 text-text-secondary"
                style={{ height: 26, paddingLeft: 8 }}
              >
                <IconChevronDown size={11} className="text-text-muted" />
                <RenameInput
                  value={creatingFolder}
                  onChange={setCreatingFolder}
                  onCommit={commitNewFolder}
                  onCancel={() => setCreatingFolder(null)}
                  ariaLabel="New folder name"
                />
              </div>
            )}
            {roots.map((r) => renderFolder(r, 0))}
            {rootNotes.map((n) => (
              <NoteRow
                key={n.id}
                row={n}
                indent={8}
                active={n.id === selectedId}
                dragging={drag?.kind === "note" && drag.id === n.id}
                dropTarget={drag !== null && dropRowId === n.id}
                onSelect={() => selectNote(n.id)}
                onDragStart={() => setDrag({ kind: "note", id: n.id })}
                onDragEnd={clearDrag}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropFolder(n.folder);
                  setDropRowId(n.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnto(n.folder);
                }}
                renaming={renamingNote?.id === n.id}
                renameValue={
                  renamingNote !== null && renamingNote.id === n.id
                    ? renamingNote.value
                    : ""
                }
                onRenameChange={(value) => setRenamingNote({ id: n.id, value })}
                onRenameCommit={commitRenameNote}
                onRenameCancel={() => setRenamingNote(null)}
                onBeginRename={() => beginRenameNote(n)}
                onDelete={() => {
                  handleDeleteNote(n);
                  setArmedDelete(null);
                }}
                armed={armedDelete?.kind === "note" && armedDelete.id === n.id}
                onArmDelete={() => setArmedDelete({ kind: "note", id: n.id })}
                onCancelDelete={() => setArmedDelete(null)}
                coarse={coarse}
                onMove={() =>
                  setMoveTarget({
                    kind: "note",
                    id: n.id,
                    currentPath: n.folder,
                  })
                }
              />
            ))}
          </>
        )}
      </div>
      <ConfirmDialog
        open={pendingFolderDelete !== null}
        title="Delete folder?"
        body={
          pendingFolderDelete === null ? null : (
            <>
              <strong style={{ color: "var(--color-text-primary)" }}>
                {leafOf(pendingFolderDelete.path)}
              </strong>{" "}
              holds {pendingFolderDelete.noteIds.length} note
              {pendingFolderDelete.noteIds.length === 1 ? "" : "s"}. Deleting
              the folder deletes them all. You can undo this.
            </>
          )
        }
        confirmLabel="Delete"
        onConfirm={confirmFolderDelete}
        onCancel={() => setPendingFolderDelete(null)}
      />
      <MoveToFolderDialog
        open={moveTarget !== null}
        title={
          moveTarget === null
            ? ""
            : moveTarget.kind === "folder"
              ? leafOf(moveTarget.id)
              : (rows ?? []).find((r) => r.id === moveTarget.id)?.title ||
                "Untitled"
        }
        folders={allFolders}
        currentPath={moveTarget?.currentPath ?? ""}
        onPick={applyMove}
        onCancel={() => setMoveTarget(null)}
      />
    </div>
  );
}
