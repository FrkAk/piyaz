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
  IconPlus,
  IconSearch,
  IconUser,
  IconX,
} from "@/components/shared/icons";
import type { NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import { fetchNoteSearch, fetchNotesTree } from "@/lib/query/queries";
import {
  type FolderMovePlan,
  leafOf,
  NOTE_TYPE_META,
  parentOf,
  planFolderMove,
  planFolderRename,
  tint,
  type TypeFilter,
} from "./note-meta";
import { useMoveFolder, useMoveNote } from "./useNoteMutations";

/** Debounce window between a keystroke and the server search request. */
const SEARCH_DEBOUNCE_MS = 250;

/** Type-filter chip order. */
const CHIPS: TypeFilter[] = ["all", "reference", "guidance", "knowledge"];

interface TreePaneProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param selectedId - Selected note id, or null. */
  selectedId: string | null;
  /** @param onSelect - Select a note (writes `?note=<id>`). */
  onSelect: (noteId: string) => void;
  /** @param onNewNote - Create a note in the given folder. */
  onNewNote: (folder: string) => void;
  /** @param createPending - Disables the New note button while a create is in flight. */
  createPending: boolean;
  /** @param createError - Failure message from the last note create, or null. */
  createError: string | null;
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
}

/**
 * One note row, shared between the folder tree and the flat search-hit
 * list. Draggable only when drag handlers are wired (tree mode).
 *
 * @param props - Row data, indentation, selection state, and handlers.
 * @returns The note row button.
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
}: NoteRowProps) {
  const color = NOTE_TYPE_META[row.type].color;
  const draggable = onDragStart !== undefined;
  return (
    <button
      type="button"
      draggable={draggable}
      aria-roledescription={draggable ? "Draggable note" : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      className="group relative flex w-full cursor-pointer items-center gap-2 rounded-md pr-2 text-left"
      style={{
        height: 30,
        paddingLeft: indent + 16,
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
      <span className="text-text-faint opacity-0 group-hover:opacity-100">
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
      {!row.agentWritable && <IconLock size={10} className="text-text-faint" />}
    </button>
  );
}

interface FolderRenameInputProps {
  /** @param value - Current draft name. */
  value: string;
  /** @param onChange - Draft name change. */
  onChange: (value: string) => void;
  /** @param onCommit - Commit the rename (Enter or blur). */
  onCommit: () => void;
  /** @param onCancel - Cancel the rename (Escape). */
  onCancel: () => void;
}

/**
 * Inline folder rename field, swapped in for the folder label. Focuses
 * and selects its content on mount; Enter and blur commit, Escape
 * cancels.
 *
 * @param props - Draft value and commit/cancel wiring.
 * @returns The rename input.
 */
function FolderRenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: FolderRenameInputProps) {
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
      aria-label="Folder name"
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
 * actions, backed by the notes tree list and the server search route.
 * Folders are path prefixes on note rows; empty folders created here are
 * client-local and persist only once a note lands in them. Folder rows
 * rename inline (double-click or F2); tree mutation failures surface in
 * a strip above the list.
 *
 * @param props - Project scope, selection state, and create wiring.
 * @returns The 266px tree column.
 */
export function TreePane({
  projectId,
  selectedId,
  onSelect,
  onNewNote,
  createPending,
  createError,
}: TreePaneProps) {
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [dropRowId, setDropRowId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{
    path: string;
    value: string;
  } | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: noteKeys.list(projectId),
    queryFn: fetchNotesTree(qc, projectId),
  });
  const rows = list.data;

  useEffect(() => {
    const trimmed = rawQuery.trim();
    if (trimmed === "") return;
    const id = setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS);
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

  const visibleRows = useMemo(() => {
    const all = rows ?? [];
    return typeFilter === "all"
      ? all
      : all.filter((r) => r.type === typeFilter);
  }, [rows, typeFilter]);

  const allFolders = useMemo(() => {
    const set = new Set<string>(extraFolders);
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
  }, [rows, extraFolders]);

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

  /** Create a uniquely-named empty root folder (client-local). */
  function handleNewFolder() {
    const existing = new Set(allFolders);
    let name = "New folder";
    let i = 2;
    while (existing.has(name)) name = `New folder ${i++}`;
    setExtraFolders((f) => [...f, name]);
  }

  /** Create a note in the selected row's folder, or Drafts. */
  function handleNewNote() {
    const selectedRow = selectedId
      ? (rows ?? []).find((r) => r.id === selectedId)
      : undefined;
    onNewNote(selectedRow?.folder ? selectedRow.folder : "Drafts");
  }

  /**
   * Rewrite client-local state keyed by folder path (empty extra folders
   * and collapsed entries) under a moved prefix.
   *
   * @param src - Source folder path.
   * @param dest - Destination folder path.
   */
  function rewriteLocalPaths(src: string, dest: string) {
    const rewrite = (f: string) =>
      f === src || f.startsWith(`${src}/`) ? dest + f.slice(src.length) : f;
    setExtraFolders((fs) => fs.map(rewrite));
    setCollapsed((c) => new Set([...c].map(rewrite)));
  }

  /**
   * Whether any server note lives in a folder or its subtree.
   *
   * @param path - Folder path.
   * @returns True when at least one note row is under the path.
   */
  function folderHasNotes(path: string): boolean {
    return (rows ?? []).some(
      (r) => r.folder === path || r.folder.startsWith(`${path}/`),
    );
  }

  /**
   * Dispatch a folder mutation plan from rename or drag re-parent.
   * Collisions surface in the error strip without dispatching (no
   * silent merge). Folders without server notes move as a pure
   * client-local path rewrite; otherwise the whole subtree re-parents
   * server-side via `moveFolder`.
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
    if (!folderHasNotes(src)) {
      rewriteLocalPaths(src, plan.dest);
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
            <FolderRenameInput
              value={renaming.value}
              onChange={(value) => setRenaming({ path, value })}
              onCommit={commitRename}
              onCancel={() => setRenaming(null)}
            />
          </div>
        ) : (
          <button
            type="button"
            draggable
            aria-roledescription="Draggable folder"
            onClick={() => toggle(path)}
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
            className="group flex w-full items-center gap-1 rounded-md pr-2 text-left text-text-secondary"
            style={{
              height: 26,
              paddingLeft: indent,
              opacity: drag?.kind === "folder" && drag.id === path ? 0.45 : 1,
              background: isDropTarget
                ? tint("var(--color-accent)", 14)
                : "transparent",
              outline: isDropTarget
                ? "1px solid var(--color-accent)"
                : "1px solid transparent",
            }}
          >
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
                onSelect={() => onSelect(n.id)}
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
              />
            ))}
          </>
        )}
      </div>
    );
  }

  const roots = allFolders.filter((f) => parentOf(f) === "");
  const rootNotes = notesByFolder.get("") ?? [];

  return (
    <div
      className="flex shrink-0 flex-col"
      style={{
        width: 266,
        background: "var(--color-base-2)",
        borderRight: "1px solid var(--color-border)",
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

      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
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
              className="inline-flex cursor-pointer items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
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

      {(treeError ?? createError) !== null && (
        <p
          className="px-3 pb-1.5 font-mono text-[10.5px]"
          style={{ color: "var(--color-danger)" }}
        >
          {treeError ?? createError}
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
                onSelect={() => onSelect(h.id)}
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
        ) : roots.length === 0 && rootNotes.length === 0 ? (
          <p className="px-2 pt-2 font-mono text-[11px] text-text-faint">
            No notes yet
          </p>
        ) : (
          <>
            {roots.map((r) => renderFolder(r, 0))}
            {rootNotes.map((n) => (
              <NoteRow
                key={n.id}
                row={n}
                indent={8}
                active={n.id === selectedId}
                dragging={drag?.kind === "note" && drag.id === n.id}
                dropTarget={drag !== null && dropRowId === n.id}
                onSelect={() => onSelect(n.id)}
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
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
