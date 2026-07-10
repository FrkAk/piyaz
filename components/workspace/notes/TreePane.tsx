"use client";

import {
  type DragEvent,
  memo,
  useCallback,
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
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
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
  IconUser,
  IconX,
} from "@/components/shared/icons";
import { Dropdown } from "@/components/shared/Dropdown";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useUndo, UndoButton } from "@/hooks/useUndo";
import type { NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import { casToken } from "@/lib/query/note-cache";
import {
  fetchNoteFolders,
  fetchNoteSearch,
  fetchNotesTree,
} from "@/lib/query/queries";
import { DeleteConfirm } from "@/components/workspace/structure/DeleteConfirm";
import { ConfirmDialog } from "./ConfirmDialog";
import { MoveToFolderDialog } from "./MoveToFolderDialog";
import {
  type FlatTreeRow,
  flattenNoteTree,
  type FolderMovePlan,
  groupFoldersByParent,
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

/**
 * Row glide on the virtualizer's translateY wrappers, matching the pane's
 * 180ms curve. Fires only when a mounted row's offset changes (insert,
 * remove, move, collapse above it), never on scroll-driven mounts, and
 * sits behind `motion-safe:` so reduced motion disables it.
 */
const ROW_GLIDE_CLASS =
  "motion-safe:transition-transform motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]";

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

/**
 * Current drop target: the hovered folder path plus the hovered note row
 * id when the pointer sits over a note rather than a folder header.
 */
type DropTarget = { folder: string; rowId: string | null };

interface NoteRowProps {
  row: NoteTreeRow;
  indent: number;
  active: boolean;
  dragging: boolean;
  dropTarget?: boolean;
  onSelect: (noteId: string) => void;
  onDragStart?: (noteId: string) => void;
  onDragEnd?: () => void;
  onDragOver?: (
    folder: string,
    noteId: string,
    e: DragEvent<HTMLButtonElement>,
  ) => void;
  onDrop?: (folder: string, e: DragEvent<HTMLButtonElement>) => void;
  renaming?: boolean;
  renameValue?: string;
  onRenameChange?: (noteId: string, value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
  onBeginRename?: (row: NoteTreeRow) => void;
  onDelete?: (row: NoteTreeRow) => void;
  armed?: boolean;
  onArmDelete?: (noteId: string) => void;
  onCancelDelete?: () => void;
  coarse?: boolean;
  onMove?: (row: NoteTreeRow) => void;
}

/** Row action-menu option values. */
type RowAction = "rename" | "move" | "delete";

/** Action-menu options shared by note and folder rows. */
const ROW_ACTION_OPTIONS: { value: RowAction; label: string }[] = [
  { value: "rename", label: "Rename" },
  { value: "move", label: "Move to folder…" },
  { value: "delete", label: "Delete" },
];

interface RowActionsMenuProps {
  /** @param label - Accessible label for the trigger. */
  label: string;
  /** @param coarse - Coarse pointer: keep the trigger always visible. */
  coarse: boolean;
  /** @param onRename - Enter inline rename. */
  onRename: () => void;
  /** @param onMove - Open the move-to-folder picker. */
  onMove: () => void;
  /** @param onDelete - Arm or open the delete confirm. */
  onDelete: () => void;
}

/**
 * Overflow menu in a row's trailing slot: Rename, Move, Delete. Always
 * visible on coarse pointers, where native drag never fires; on fine
 * pointers it reveals on row hover or keyboard focus and stays visible
 * while its menu is open (the open panel holds focus outside the row),
 * making it the keyboard reorganize path.
 *
 * @param props - Accessible label, pointer mode, and action handlers.
 * @returns The anchored `⋯` action menu.
 */
function RowActionsMenu({
  label,
  coarse,
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
        renderTrigger={(_active, open) => (
          <span
            className={`inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary in-focus-visible:bg-surface-hover in-focus-visible:text-text-primary ${
              coarse || open
                ? ""
                : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
          >
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
 * mode double-click or F2 opens the inline rename input and the trailing
 * overflow menu renames, moves, or deletes the note; the search-hit list
 * wires neither. Memoized with id-taking handlers so parent state churn
 * skips uninvolved rows.
 *
 * @param props - Row data, indentation, selection state, and handlers.
 * @returns The note row, or its inline rename input while renaming.
 */
const NoteRow = memo(function NoteRow({
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
          onChange={(value) => onRenameChange?.(row.id, value)}
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
        onDragStart={
          onDragStart === undefined ? undefined : () => onDragStart(row.id)
        }
        onDragEnd={onDragEnd}
        onDragOver={
          onDragOver === undefined
            ? undefined
            : (e) => onDragOver(row.folder, row.id, e)
        }
        onDrop={onDrop === undefined ? undefined : (e) => onDrop(row.folder, e)}
        onClick={() => onSelect(row.id)}
        onDoubleClick={
          onBeginRename === undefined ? undefined : () => onBeginRename(row)
        }
        onKeyDown={
          onBeginRename === undefined
            ? undefined
            : (e) => {
                if (e.key === "F2") {
                  e.preventDefault();
                  onBeginRename(row);
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
              autoFocus
              onConfirm={() => onDelete(row)}
              onCancel={() => onCancelDelete?.()}
            />
          </span>
        ) : (
          <RowActionsMenu
            label="Note actions"
            coarse={coarse}
            onRename={() => onBeginRename?.(row)}
            onMove={() => onMove?.(row)}
            onDelete={() => onArmDelete?.(row.id)}
          />
        ))}
    </div>
  );
});

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

interface FolderRowProps {
  path: string;
  indent: number;
  noteCount: number;
  collapsed: boolean;
  selected: boolean;
  dropTarget: boolean;
  dragging: boolean;
  renaming: boolean;
  renameValue: string;
  armed: boolean;
  coarse: boolean;
  onClick: (path: string) => void;
  onBeginRename: (path: string) => void;
  onRenameChange: (path: string, value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDragStart: (path: string, e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (path: string, e: DragEvent<HTMLButtonElement>) => void;
  onDrop: (path: string, e: DragEvent<HTMLButtonElement>) => void;
  onDelete: (path: string) => void;
  onConfirmDelete: (path: string) => void;
  onCancelDelete: () => void;
  onMove: (path: string) => void;
}

/**
 * One folder row. Clicking toggles collapse and selects the folder as the
 * New-note create target; double-click or F2 opens the inline rename
 * input; the trailing overflow menu renames, moves, or arms a two-step
 * delete. Memoized with path-taking handlers so parent state churn skips
 * uninvolved rows.
 *
 * @param props - Folder path, indentation, row state flags, and handlers.
 * @returns The folder row, or its inline rename input while renaming.
 */
const FolderRow = memo(function FolderRow({
  path,
  indent,
  noteCount,
  collapsed,
  selected,
  dropTarget,
  dragging,
  renaming,
  renameValue,
  armed,
  coarse,
  onClick,
  onBeginRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onMove,
}: FolderRowProps) {
  if (renaming) {
    return (
      <div
        className="flex w-full items-center gap-1 rounded-md pr-2 text-text-secondary"
        style={{ height: 26, paddingLeft: indent }}
      >
        {collapsed ? (
          <IconChevronRight size={11} className="text-text-muted" />
        ) : (
          <IconChevronDown size={11} className="text-text-muted" />
        )}
        <RenameInput
          value={renameValue}
          onChange={(value) => onRenameChange(path, value)}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
          ariaLabel="Folder name"
        />
      </div>
    );
  }

  return (
    <div className="group relative flex w-full items-center">
      <button
        type="button"
        draggable
        aria-roledescription="Draggable folder"
        aria-current={selected ? "true" : undefined}
        onClick={() => onClick(path)}
        onDoubleClick={() => onBeginRename(path)}
        onKeyDown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            onBeginRename(path);
          }
        }}
        onDragStart={(e) => onDragStart(path, e)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOver(path, e)}
        onDrop={(e) => onDrop(path, e)}
        className="relative flex min-w-0 flex-1 items-center gap-1 rounded-md text-left"
        style={{
          height: 26,
          paddingLeft: indent,
          paddingRight: 30,
          opacity: dragging ? 0.45 : 1,
          color: selected
            ? "var(--color-text-primary)"
            : "var(--color-text-secondary)",
          background: dropTarget
            ? tint("var(--color-accent)", 14)
            : selected
              ? tint("var(--color-accent)", 7)
              : "transparent",
          outline: dropTarget
            ? "1px solid var(--color-accent)"
            : "1px solid transparent",
        }}
      >
        {selected && (
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
        {collapsed ? (
          <IconChevronRight size={11} className="text-text-muted" />
        ) : (
          <IconChevronDown size={11} className="text-text-muted" />
        )}
        <span className="text-[12px] font-semibold">{leafOf(path)}</span>
        <span className="ml-auto font-mono text-[10px] text-text-faint">
          {noteCount}
        </span>
      </button>
      {armed ? (
        <span
          className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded px-0.5"
          style={{ background: "var(--color-base-2)" }}
        >
          <DeleteConfirm
            autoFocus
            onConfirm={() => onConfirmDelete(path)}
            onCancel={onCancelDelete}
          />
        </span>
      ) : (
        <RowActionsMenu
          label="Folder actions"
          coarse={coarse}
          onRename={() => onBeginRename(path)}
          onMove={() => onMove(path)}
          onDelete={() => onDelete(path)}
        />
      )}
    </div>
  );
});

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
 * selection. Folder and note rows rename inline (double-click or F2).
 * Every row carries an overflow menu in its trailing slot exposing
 * Rename, Move to folder, and Delete: always visible on coarse pointers
 * (where native drag never fires), revealed on hover or keyboard focus
 * on fine pointers, so the menu is also the keyboard reorganize path.
 * Delete arms a two-step inline confirm: a note deletes with an Undo
 * entry, an empty folder deletes its marker rows, and a non-empty folder
 * instead opens a bulk modal then deletes its notes as one undoable
 * entry. Tree mutation failures surface in a strip above the list. On
 * fine pointers notes and folders also reorder by native drag-and-drop.
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
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
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
  const [pendingFocus, setPendingFocus] = useState<{
    key: string;
    fallbackKey: string | null;
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

  const { mutate: mutateMoveNote } = useMoveNote(projectId);
  const { mutate: mutateMoveFolder } = useMoveFolder(projectId);
  const { mutate: mutateUpdateNote } = useUpdateNote(projectId);
  const { mutate: mutateDeleteNote, mutateAsync: deleteNoteAsync } =
    useDeleteNote(projectId);
  const { mutateAsync: restoreNoteAsync } = useRestoreNote(projectId);
  const { mutate: mutateCreateFolder } = useCreateFolder(projectId);
  const { mutate: mutateDeleteFolder } = useDeleteFolder(projectId);

  const {
    canUndo,
    push: pushUndo,
    undo,
  } = useUndo<{ notes: { id: string; token?: string }[]; label: string }>({
    onUndo: async (item) => {
      for (const n of item.notes) {
        const result = await restoreNoteAsync({
          noteId: n.id,
          ifUpdatedAt: n.token,
        });
        if (!result.ok) throw new Error(result.message);
      }
    },
    resetOn: projectId,
    keyboard: true,
  });

  const dropTargetRef = useRef<DropTarget | null>(null);
  const dragRef = useRef<DragItem | null>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);
  // `onSelect`'s identity follows the URL search params upstream; reading
  // it through a ref keeps the row-facing callbacks stable across
  // selection changes so memoized rows skip re-render.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const renamingRef = useRef(renaming);
  useEffect(() => {
    renamingRef.current = renaming;
  }, [renaming]);
  const renamingNoteRef = useRef(renamingNote);
  useEffect(() => {
    renamingNoteRef.current = renamingNote;
  }, [renamingNote]);

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

  /**
   * Folder row click: toggle collapse and select the folder as the
   * New-note create target.
   */
  const handleFolderClick = useCallback((path: string) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setSelectedFolder(path);
  }, []);

  /** Clear the in-flight drag state. */
  const clearDrag = useCallback(() => {
    dropTargetRef.current = null;
    setDrag(null);
    setDropTarget(null);
  }, []);

  /** Start dragging a note row. */
  const handleNoteDragStart = useCallback((noteId: string) => {
    setDrag({ kind: "note", id: noteId });
  }, []);

  /** Start dragging a folder row. */
  const handleFolderDragStart = useCallback(
    (path: string, e: DragEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setDrag({ kind: "folder", id: path });
    },
    [],
  );

  /**
   * Drag-over on a folder row. `preventDefault` must run on every event
   * or the browser never fires the drop; the state write is guarded so an
   * unchanged target schedules no update.
   */
  const handleFolderDragOver = useCallback(
    (path: string, e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const current = dropTargetRef.current;
      if (current !== null && current.folder === path && current.rowId === null)
        return;
      const next: DropTarget = { folder: path, rowId: null };
      dropTargetRef.current = next;
      setDropTarget(next);
    },
    [],
  );

  /**
   * Drag-over on a note row: targets the note's folder while highlighting
   * the hovered row. Same unconditional-`preventDefault` and guarded
   * state write as {@link handleFolderDragOver}.
   */
  const handleNoteDragOver = useCallback(
    (folder: string, noteId: string, e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const current = dropTargetRef.current;
      if (
        current !== null &&
        current.folder === folder &&
        current.rowId === noteId
      )
        return;
      const next: DropTarget = { folder, rowId: noteId };
      dropTargetRef.current = next;
      setDropTarget(next);
    },
    [],
  );

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
    mutateCreateFolder(path, {
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
  const selectNote = useCallback((noteId: string) => {
    setSelectedFolder(null);
    onSelectRef.current(noteId);
  }, []);

  /**
   * Rewrite client-local state keyed by folder path (collapsed entries
   * and the selected folder) under a moved prefix.
   *
   * @param src - Source folder path.
   * @param dest - Destination folder path.
   */
  const rewriteLocalPaths = useCallback((src: string, dest: string) => {
    const rewrite = (f: string) =>
      f === src || f.startsWith(`${src}/`) ? dest + f.slice(src.length) : f;
    setCollapsed((c) => new Set([...c].map(rewrite)));
    setSelectedFolder((s) => (s === null ? s : rewrite(s)));
  }, []);

  /**
   * Clear the selected folder when it sits at or under a deleted path.
   *
   * @param path - Deleted folder path.
   */
  const clearSelectionUnder = useCallback((path: string) => {
    setSelectedFolder((s) =>
      s !== null && (s === path || s.startsWith(`${path}/`)) ? null : s,
    );
  }, []);

  /**
   * Dispatch a folder mutation plan from rename or drag re-parent.
   * Collisions surface in the error strip without dispatching (no
   * silent merge). The whole subtree re-parents server-side via
   * `moveFolder`, which also rewrites explicit empty-folder rows, so an
   * empty folder's rename or move survives a reload.
   *
   * @param src - Folder path being moved or renamed.
   * @param plan - Plan from {@link planFolderRename} or {@link planFolderMove}.
   * @param onSettledPath - Called with the folder's settled path: the
   *   destination on success, the unchanged source on failure.
   */
  const applyFolderPlan = useCallback(
    (
      src: string,
      plan: FolderMovePlan,
      onSettledPath?: (path: string) => void,
    ) => {
      if (plan.kind === "noop") return;
      if (plan.kind === "collision") {
        setTreeError(`Folder "${plan.dest}" already exists`);
        return;
      }
      mutateMoveFolder(
        { src, destParent: plan.destParent, leaf: plan.leaf, dest: plan.dest },
        {
          onSuccess: (result) => {
            if (result.ok) {
              rewriteLocalPaths(src, result.data.dest);
              onSettledPath?.(result.data.dest);
              return;
            }
            setTreeError(result.message);
            onSettledPath?.(src);
          },
          onError: () => {
            setTreeError("Folder move failed");
            onSettledPath?.(src);
          },
        },
      );
    },
    [mutateMoveFolder, rewriteLocalPaths],
  );

  /**
   * Complete a drop onto a folder, moving the dragged note or folder.
   * Self/descendant folder drops and no-op moves never dispatch;
   * collisions and failures surface in the tree error strip.
   *
   * @param path - Target folder path.
   */
  const dropOnto = useCallback(
    (path: string) => {
      const item = dragRef.current;
      clearDrag();
      if (!item) return;
      setTreeError(null);
      if (item.kind === "note") {
        const row = (rows ?? []).find((r) => r.id === item.id);
        if (!row || row.folder === path) return;
        mutateMoveNote(
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
    },
    [rows, allFolders, mutateMoveNote, applyFolderPlan, clearDrag],
  );

  /** Drop on a folder or note row: move the dragged item into the folder. */
  const handleDrop = useCallback(
    (folder: string, e: DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      dropOnto(folder);
    },
    [dropOnto],
  );

  /**
   * Enter inline rename mode on a folder row.
   *
   * @param path - Folder path to rename.
   */
  const beginRename = useCallback((path: string) => {
    setTreeError(null);
    setRenaming({ path, value: leafOf(path) });
  }, []);

  /** Update the in-flight folder rename draft. */
  const handleRenameChange = useCallback((path: string, value: string) => {
    setRenaming({ path, value });
  }, []);

  /** Commit the in-flight rename through {@link applyFolderPlan}. */
  const commitRename = useCallback(() => {
    const r = renamingRef.current;
    if (!r) return;
    setRenaming(null);
    applyFolderPlan(r.path, planFolderRename(r.path, r.value, allFolders));
  }, [allFolders, applyFolderPlan]);

  /** Cancel the in-flight folder rename. */
  const cancelRename = useCallback(() => setRenaming(null), []);

  /**
   * Enter inline rename mode on a note row.
   *
   * @param row - Note row to rename.
   */
  const beginRenameNote = useCallback((row: NoteTreeRow) => {
    setTreeError(null);
    setRenamingNote({ id: row.id, value: row.title });
  }, []);

  /** Update the in-flight note rename draft. */
  const handleNoteRenameChange = useCallback(
    (noteId: string, value: string) => {
      setRenamingNote({ id: noteId, value });
    },
    [],
  );

  /**
   * Commit the in-flight note rename. A blank or unchanged title is a
   * no-op; a real change patches the title, which re-slugs a still-
   * untitled note server-side.
   */
  const commitRenameNote = useCallback(() => {
    const r = renamingNoteRef.current;
    if (r === null) return;
    setRenamingNote(null);
    const row = (rows ?? []).find((x) => x.id === r.id);
    const next = r.value.trim();
    if (row === undefined || next === "" || next === row.title) return;
    mutateUpdateNote({ noteId: r.id, patch: { title: next } });
  }, [rows, mutateUpdateNote]);

  /** Cancel the in-flight note rename. */
  const cancelRenameNote = useCallback(() => setRenamingNote(null), []);

  /**
   * Soft-delete a note, disarm the confirm, and push a single-note undo
   * entry.
   *
   * @param row - Note row to delete.
   */
  const handleDeleteNote = useCallback(
    (row: NoteTreeRow) => {
      setTreeError(null);
      setArmedDelete(null);
      if (row.id === selectedIdRef.current) onSelectRef.current(null);
      mutateDeleteNote(row.id, {
        onSuccess: (result) => {
          if (result.ok) {
            pushUndo({
              notes: [{ id: row.id, token: casToken(result.data.updatedAt) }],
              label: row.title || "Untitled",
            });
          } else {
            setTreeError(result.message);
          }
        },
        onError: () => setTreeError("Delete failed"),
      });
    },
    [mutateDeleteNote, pushUndo],
  );

  /** Arm the two-step delete confirm on a note row. */
  const armNoteDelete = useCallback((noteId: string) => {
    setArmedDelete({ kind: "note", id: noteId });
  }, []);

  /** Disarm the two-step delete confirm. */
  const cancelArmedDelete = useCallback(() => setArmedDelete(null), []);

  /**
   * Delete a folder. An empty client-local folder arms the inline
   * two-step confirm; a folder holding notes opens the bulk modal.
   *
   * @param path - Folder path to delete.
   */
  const handleDeleteFolder = useCallback(
    (path: string) => {
      setTreeError(null);
      const ids = (rows ?? [])
        .filter((r) => r.folder === path || r.folder.startsWith(`${path}/`))
        .map((r) => r.id);
      if (ids.length === 0) {
        setArmedDelete({ kind: "folder", id: path });
        return;
      }
      setPendingFolderDelete({ path, noteIds: ids });
    },
    [rows],
  );

  /**
   * Delete an empty folder's explicit rows server-side and disarm.
   *
   * @param path - Folder path to remove.
   */
  const dropEmptyFolder = useCallback(
    (path: string) => {
      setArmedDelete(null);
      clearSelectionUnder(path);
      mutateDeleteFolder(path, {
        onSuccess: (result) => {
          if (!result.ok) setTreeError(result.message);
        },
        onError: () => setTreeError("Delete failed"),
      });
    },
    [clearSelectionUnder, mutateDeleteFolder],
  );

  /** Open the move-to-folder picker for a note row. */
  const openMoveNote = useCallback((row: NoteTreeRow) => {
    setMoveTarget({ kind: "note", id: row.id, currentPath: row.folder });
  }, []);

  /** Open the move-to-folder picker for a folder row. */
  const openMoveFolder = useCallback((path: string) => {
    setMoveTarget({ kind: "folder", id: path, currentPath: parentOf(path) });
  }, []);

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
    mutateDeleteFolder(pending.path, {
      onSuccess: (result) => {
        if (!result.ok) setTreeError(result.message);
      },
      onError: () => setTreeError("Delete failed"),
    });
    const results = await Promise.all(
      pending.noteIds.map((id) => deleteNoteAsync(id).catch(() => null)),
    );
    for (const result of results) {
      if (result === null) setTreeError("Delete failed");
      else if (!result.ok) setTreeError(result.message);
    }
    pushUndo({
      notes: pending.noteIds.map((id, i) => {
        const result = results[i];
        return result?.ok
          ? { id, token: casToken(result.data.updatedAt) }
          : { id };
      }),
      label: leafOf(pending.path),
    });
  }

  /**
   * Apply the pending move to the chosen destination. A note moves
   * folders; a folder re-parents through {@link applyFolderPlan}. The
   * focus hand-back to the moved row is queued from the mutation
   * callbacks (only then has the tree committed the row's final key),
   * targeting the origin key when the move failed and the row stayed put.
   *
   * @param dest - Destination folder path (`""` = root).
   */
  function applyMove(dest: string) {
    const target = moveTarget;
    setMoveTarget(null);
    if (target === null) return;
    setTreeError(null);
    const fallbackKey = dest === "" ? null : `folder:${dest}`;
    if (target.kind === "note") {
      mutateMoveNote(
        { noteId: target.id, folder: dest },
        {
          onSuccess: (result) => {
            if (!result.ok) setTreeError(result.message);
            setPendingFocus({
              key: target.id,
              fallbackKey: result.ok ? fallbackKey : null,
            });
          },
          onError: () => {
            setTreeError("Move failed");
            setPendingFocus({ key: target.id, fallbackKey: null });
          },
        },
      );
      return;
    }
    applyFolderPlan(
      target.id,
      planFolderMove(target.id, dest, allFolders),
      (path) => setPendingFocus({ key: `folder:${path}`, fallbackKey }),
    );
  }

  const foldersByParent = useMemo(
    () => groupFoldersByParent(allFolders),
    [allFolders],
  );

  const flatItems = useMemo<FlatTreeRow[]>(
    () =>
      searching
        ? hits.map((h) => ({
            kind: "note" as const,
            key: h.id,
            note: h,
            indent: 8,
          }))
        : flattenNoteTree(foldersByParent, notesByFolder, collapsed),
    [searching, hits, foldersByParent, notesByFolder, collapsed],
  );

  const keyIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatItems.forEach((item, index) => map.set(item.key, index));
    return map;
  }, [flatItems]);

  // Rows that must stay mounted off-viewport: the native drag source (an
  // unmounted source never fires `dragend`, stranding drag state), the
  // focused rename input (unmounting it on a realtime reorder blurs it),
  // and the move dialog's origin row (its focus hand-back needs the node).
  const pinnedIndexes = useMemo(() => {
    const keys: string[] = [];
    if (drag !== null) {
      keys.push(drag.kind === "note" ? drag.id : `folder:${drag.id}`);
    }
    if (renamingNote !== null) keys.push(renamingNote.id);
    if (renaming !== null) keys.push(`folder:${renaming.path}`);
    if (moveTarget !== null) {
      keys.push(
        moveTarget.kind === "note" ? moveTarget.id : `folder:${moveTarget.id}`,
      );
    }
    const indexes: number[] = [];
    for (const key of keys) {
      const index = keyIndex.get(key);
      if (index !== undefined) indexes.push(index);
    }
    return indexes;
  }, [drag, renamingNote, renaming, moveTarget, keyIndex]);

  const rangeExtractor = useCallback(
    (range: Range) =>
      pinnedIndexes.length === 0
        ? defaultRangeExtractor(range)
        : [
            ...new Set([...pinnedIndexes, ...defaultRangeExtractor(range)]),
          ].sort((a, b) => a - b),
    [pinnedIndexes],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  /** Virtual-list offset inside the scroll element: the naming-first folder input renders above it. */
  const scrollMargin = creatingFolder === null ? 0 : 26;
  // Sizes are fixed inline per row kind (folder 26, note 30, rename
  // variants identical), so positions stay pixel-accurate without
  // `measureElement`.
  //
  // `useVirtualizer` uses interior mutability; React Compiler auto-skip is safe.
  // https://react.dev/reference/eslint-plugin-react-hooks/lints/incompatible-library
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (flatItems[index]?.kind === "folder" ? 26 : 30),
    getItemKey: (index) => flatItems[index]?.key ?? index,
    overscan: 8,
    rangeExtractor,
    scrollMargin,
  });

  // Focus hand-back after the move dialog closes: ModalShell's own restore
  // targets whatever was focused when the dialog opened (often a menu node
  // detached by re-render), so this effect re-resolves the row by its flat
  // key, scrolls it into the virtual window, and focuses its main button.
  // It runs only while the hand-back would not yank focus: if focus sits
  // outside the row list (and not on `body`), e.g. the user reached the
  // editor before a slow mutation settled, the request is dropped. The
  // frame callback resolves the row by `data-key` (indexes shift when the
  // optimistic tree update commits); the `keyIndex` dependency retries it
  // on the next tree render. Every attempt re-arms a short expiry, so a
  // request that never resolves (row under a collapsed folder with no
  // fallback, deleted, re-keyed by realtime, or whose node never
  // materializes after the scroll) clears itself instead of stealing
  // focus later.
  useEffect(() => {
    if (pendingFocus === null) return;
    const active = document.activeElement;
    const canTakeFocus =
      active === null ||
      active === document.body ||
      (scrollRef.current?.contains(active) ?? false);
    if (!canTakeFocus) {
      setPendingFocus(null);
      return;
    }
    const timer = setTimeout(() => setPendingFocus(null), 1500);
    const key = keyIndex.has(pendingFocus.key)
      ? pendingFocus.key
      : pendingFocus.fallbackKey !== null &&
          keyIndex.has(pendingFocus.fallbackKey)
        ? pendingFocus.fallbackKey
        : null;
    if (key === null) return () => clearTimeout(timer);
    const index = keyIndex.get(key);
    if (index !== undefined) virtualizer.scrollToIndex(index);
    const resolve = (k: string) =>
      scrollRef.current?.querySelector<HTMLButtonElement>(
        `[data-key="${CSS.escape(k)}"] button`,
      );
    const settle = (row: HTMLButtonElement) => {
      row.focus();
      setPendingFocus(null);
    };
    let frame = requestAnimationFrame(() => {
      const row = resolve(pendingFocus.key);
      if (row) {
        settle(row);
        return;
      }
      frame = requestAnimationFrame(() => {
        const retry =
          resolve(pendingFocus.key) ??
          (pendingFocus.fallbackKey === null
            ? undefined
            : resolve(pendingFocus.fallbackKey));
        if (retry) settle(retry);
      });
    });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [pendingFocus, keyIndex, virtualizer]);

  const showVirtual = searching
    ? !search.isError && flatItems.length > 0
    : !list.isError && !list.isPending && flatItems.length > 0;
  const foldersError = folders.isError ? "Failed to load folders" : null;

  return (
    <div
      className={
        fill ? "flex h-full w-full flex-col" : "flex h-full min-h-0 flex-col"
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
            <IconPlus
              size={13}
              className={
                createPending ? "motion-safe:animate-pulse" : undefined
              }
            />
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {searching ? (
          search.isError ? (
            <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
              Search failed
            </p>
          ) : hits.length > 0 ? null : search.isPending ? (
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
        ) : flatItems.length === 0 && creatingFolder === null ? (
          <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
            No notes yet
          </p>
        ) : creatingFolder !== null ? (
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
        ) : null}
        {showVirtual && (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const item = flatItems[vi.index];
              if (!item) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  data-key={String(vi.key)}
                  className={ROW_GLIDE_CLASS}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start - scrollMargin}px)`,
                  }}
                >
                  {item.kind === "folder" ? (
                    <FolderRow
                      path={item.path}
                      indent={item.indent}
                      noteCount={item.noteCount}
                      collapsed={collapsed.has(item.path)}
                      selected={selectedFolder === item.path}
                      dropTarget={dropTarget?.folder === item.path}
                      dragging={
                        drag?.kind === "folder" && drag.id === item.path
                      }
                      renaming={renaming?.path === item.path}
                      renameValue={
                        renaming?.path === item.path ? renaming.value : ""
                      }
                      armed={
                        armedDelete?.kind === "folder" &&
                        armedDelete.id === item.path
                      }
                      coarse={coarse}
                      onClick={handleFolderClick}
                      onBeginRename={beginRename}
                      onRenameChange={handleRenameChange}
                      onRenameCommit={commitRename}
                      onRenameCancel={cancelRename}
                      onDragStart={handleFolderDragStart}
                      onDragEnd={clearDrag}
                      onDragOver={handleFolderDragOver}
                      onDrop={handleDrop}
                      onDelete={handleDeleteFolder}
                      onConfirmDelete={dropEmptyFolder}
                      onCancelDelete={cancelArmedDelete}
                      onMove={openMoveFolder}
                    />
                  ) : (
                    <NoteRow
                      row={item.note}
                      indent={item.indent}
                      active={item.note.id === selectedId}
                      dragging={
                        drag?.kind === "note" && drag.id === item.note.id
                      }
                      dropTarget={
                        drag !== null && dropTarget?.rowId === item.note.id
                      }
                      onSelect={selectNote}
                      onDragStart={searching ? undefined : handleNoteDragStart}
                      onDragEnd={searching ? undefined : clearDrag}
                      onDragOver={searching ? undefined : handleNoteDragOver}
                      onDrop={searching ? undefined : handleDrop}
                      renaming={!searching && renamingNote?.id === item.note.id}
                      renameValue={
                        renamingNote?.id === item.note.id
                          ? renamingNote.value
                          : ""
                      }
                      onRenameChange={
                        searching ? undefined : handleNoteRenameChange
                      }
                      onRenameCommit={searching ? undefined : commitRenameNote}
                      onRenameCancel={searching ? undefined : cancelRenameNote}
                      onBeginRename={searching ? undefined : beginRenameNote}
                      onDelete={searching ? undefined : handleDeleteNote}
                      armed={
                        !searching &&
                        armedDelete?.kind === "note" &&
                        armedDelete.id === item.note.id
                      }
                      onArmDelete={searching ? undefined : armNoteDelete}
                      onCancelDelete={searching ? undefined : cancelArmedDelete}
                      coarse={coarse}
                      onMove={searching ? undefined : openMoveNote}
                    />
                  )}
                </div>
              );
            })}
          </div>
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
        onCancel={() => {
          if (moveTarget !== null) {
            setPendingFocus({
              key:
                moveTarget.kind === "note"
                  ? moveTarget.id
                  : `folder:${moveTarget.id}`,
              fallbackKey: null,
            });
          }
          setMoveTarget(null);
        }}
      />
    </div>
  );
}
