"use client";

import { useMemo } from "react";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { MonoId, type MonoIdTone } from "@/components/shared/MonoId";
import { IconPanelLeft } from "@/components/shared/icons";
import { useGraphRailCollapse } from "@/components/workspace/graph/GraphRailCollapseProvider";
import { NoteSquareGlyph } from "@/components/workspace/graph/NoteSquareGlyph";
import { NOTE_TYPE_META } from "@/components/workspace/notes/note-meta";
import type { NoteGraphSlim, TaskGraphSlim } from "@/lib/data/views";

/** Width of the rail when expanded. */
const RAIL_WIDTH_EXPANDED = 240;
/** Width of the rail when collapsed. */
const RAIL_WIDTH_COLLAPSED = 40;

interface RailNodeListProps {
  /** @param tasks - Tasks visible in the list (already filtered upstream). */
  tasks: TaskGraphSlim[];
  /** @param notes - Notes visible in the list (already filtered upstream). */
  notes: NoteGraphSlim[];
  /** @param selectedNodeId - Currently selected node id (task or note). */
  selectedNodeId: string | null;
  /** @param hoveredId - Hovered node id (list-driven; mirrored on canvas). */
  hoveredId: string | null;
  /** @param onHover - Called with the hovered node id (or `null` on leave). */
  onHover: (id: string | null) => void;
  /** @param onSelectTask - Called when a task row is clicked. */
  onSelectTask: (id: string) => void;
  /** @param onSelectNote - Called when a note row is clicked. */
  onSelectNote: (id: string) => void;
  /**
   * @param stageMap - Optional override that surfaces derived sub-stages
   *   (`plannable` / `ready`) for the status glyph. When omitted or absent
   *   for a task, the schema status drives the glyph.
   */
  stageMap?: ReadonlyMap<string, string>;
  /** @param collapsed - Icon-strip mode: glyphs only, titles as tooltips. */
  collapsed?: boolean;
}

/**
 * Parse the trailing numeric segment of a ref (e.g. `MYMR-104` → 104,
 * `MYMR-N7` → 7).
 *
 * @param ref - Full task or note identifier.
 * @returns Numeric tail or 0.
 */
function refOrder(ref: string): number {
  const tail = ref.split("-").pop()?.replace(/^N/, "");
  const n = tail ? parseInt(tail, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Scrollable node list for the workspace graph: task rows first, then a
 * divided Notes section mirroring the canvas note shape. Extracted from
 * the rail shell so the mobile list drawer renders the identical rows.
 *
 * @param props - Rows, selection/hover wiring, and display mode.
 * @returns Scrollable list element.
 */
export function RailNodeList({
  tasks,
  notes,
  selectedNodeId,
  hoveredId,
  onHover,
  onSelectTask,
  onSelectNote,
  stageMap,
  collapsed = false,
}: RailNodeListProps) {
  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => refOrder(a.taskRef) - refOrder(b.taskRef)),
    [tasks],
  );
  const sortedNotes = useMemo(
    () => [...notes].sort((a, b) => refOrder(a.noteRef) - refOrder(b.noteRef)),
    [notes],
  );

  return (
    <div
      className="flex-1 overflow-y-auto py-1"
      onMouseLeave={() => onHover(null)}
    >
      {sortedTasks.map((t) => {
        const active = t.id === selectedNodeId;
        const hot = t.id === hoveredId && !active;
        if (collapsed) {
          return (
            <button
              key={t.id}
              type="button"
              onMouseEnter={() => onHover(t.id)}
              onClick={() => onSelectTask(t.id)}
              aria-current={active ? "true" : undefined}
              title={`${t.taskRef} · ${t.title}`}
              className={`relative flex w-full cursor-pointer items-center justify-center py-1.5 transition-colors ${
                active
                  ? "bg-surface-hover"
                  : hot
                    ? "bg-surface-hover/60"
                    : "hover:bg-surface-hover/40"
              }`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-sm"
                  style={{ background: "var(--color-accent-grad)" }}
                />
              )}
              <StatusGlyph status={stageMap?.get(t.id) ?? t.status} size={11} />
            </button>
          );
        }
        return (
          <button
            key={t.id}
            type="button"
            onMouseEnter={() => onHover(t.id)}
            onClick={() => onSelectTask(t.id)}
            aria-current={active ? "true" : undefined}
            className={`relative flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors pointer-coarse:min-h-11 ${
              active
                ? "bg-surface-hover"
                : hot
                  ? "bg-surface-hover/60"
                  : "hover:bg-surface-hover/40"
            }`}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-sm"
                style={{ background: "var(--color-accent-grad)" }}
              />
            )}
            <StatusGlyph status={stageMap?.get(t.id) ?? t.status} size={11} />
            <MonoId
              id={t.taskRef}
              copyable={false}
              tone={(stageMap?.get(t.id) ?? t.status) as MonoIdTone}
            />
            <span
              className="flex-1 truncate text-[11.5px]"
              style={{
                color:
                  active || hot
                    ? "var(--color-text-primary)"
                    : "var(--color-text-secondary)",
              }}
            >
              {t.title}
            </span>
          </button>
        );
      })}
      {sortedNotes.length > 0 && (
        <>
          <div aria-hidden className="mx-3 my-1 border-t border-border" />
          {!collapsed && (
            <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-muted">
                Notes
              </span>
              <span className="font-mono text-[10px] font-semibold tabular-nums text-text-faint">
                · {sortedNotes.length}
              </span>
            </div>
          )}
          {sortedNotes.map((n) => {
            const active = n.id === selectedNodeId;
            const hot = n.id === hoveredId && !active;
            const meta = NOTE_TYPE_META[n.type];
            if (collapsed) {
              return (
                <button
                  key={n.id}
                  type="button"
                  onMouseEnter={() => onHover(n.id)}
                  onClick={() => onSelectNote(n.id)}
                  aria-current={active ? "true" : undefined}
                  title={`${n.noteRef} · ${n.title}`}
                  className={`relative flex w-full cursor-pointer items-center justify-center py-1.5 transition-colors ${
                    active
                      ? "bg-surface-hover"
                      : hot
                        ? "bg-surface-hover/60"
                        : "hover:bg-surface-hover/40"
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-sm"
                      style={{ background: "var(--color-accent-grad)" }}
                    />
                  )}
                  <NoteSquareGlyph color={meta.color} fed={n.fed} />
                </button>
              );
            }
            return (
              <button
                key={n.id}
                type="button"
                onMouseEnter={() => onHover(n.id)}
                onClick={() => onSelectNote(n.id)}
                aria-current={active ? "true" : undefined}
                className={`relative flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors pointer-coarse:min-h-11 ${
                  active
                    ? "bg-surface-hover"
                    : hot
                      ? "bg-surface-hover/60"
                      : "hover:bg-surface-hover/40"
                }`}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-sm"
                    style={{ background: "var(--color-accent-grad)" }}
                  />
                )}
                <NoteSquareGlyph color={meta.color} fed={n.fed} />
                <MonoId id={n.noteRef} copyable={false} tone="default" />
                <span
                  className="flex-1 truncate text-[11.5px]"
                  style={{
                    color:
                      active || hot
                        ? "var(--color-text-primary)"
                        : "var(--color-text-secondary)",
                  }}
                >
                  {n.title}
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

interface MiniTaskRailProps {
  /** @param tasks - Tasks visible in the rail (already filtered upstream). */
  tasks: TaskGraphSlim[];
  /** @param notes - Notes visible in the rail (already filtered upstream). */
  notes: NoteGraphSlim[];
  /** @param selectedNodeId - Currently selected node id (task or note). */
  selectedNodeId: string | null;
  /** @param hoveredId - Hovered node id (rail-driven; mirrored on canvas). */
  hoveredId: string | null;
  /** @param onHover - Called with the hovered node id (or `null` on leave). */
  onHover: (id: string | null) => void;
  /** @param onSelect - Called when a task row is clicked. */
  onSelect: (id: string) => void;
  /** @param onSelectNote - Called when a note row is clicked. */
  onSelectNote: (id: string) => void;
  /**
   * @param stageMap - Optional override that surfaces derived sub-stages
   *   (`plannable` / `ready`) for the status glyph. When omitted or absent
   *   for a task, the schema status drives the glyph.
   */
  stageMap?: ReadonlyMap<string, string>;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/**
 * Left rail for the workspace graph view. Defaults to a 240px Linear-density
 * list; collapses to a 40px icon strip via the chevron toggle so the canvas
 * gets the lion's share of the viewport when the operator wants it.
 *
 * Hovering a row propagates `onHover` to the canvas (matched node brightens);
 * clicking a task opens the task workspace, clicking a note opens the
 * in-graph note preview — both just like a node click.
 *
 * @param props - Rail configuration.
 * @returns Left rail aside element.
 */
export function MiniTaskRail({
  tasks,
  notes,
  selectedNodeId,
  hoveredId,
  onHover,
  onSelect,
  onSelectNote,
  stageMap,
  className = "",
}: MiniTaskRailProps) {
  const { collapsed, toggle: toggleCollapsed } = useGraphRailCollapse();

  const width = collapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH_EXPANDED;

  return (
    <aside
      aria-label="Graph nodes"
      className={`flex h-full min-h-0 flex-col border-r border-border bg-base-2 transition-[width] duration-200 ease-out ${className}`}
      style={{ width, flexShrink: 0 }}
    >
      <header
        className={`flex h-9 flex-shrink-0 items-center border-b border-border ${
          collapsed ? "justify-center px-1" : "gap-1.5 px-3"
        }`}
      >
        {!collapsed && (
          <>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-muted">
              Nodes
            </span>
            <span className="font-mono text-[10px] font-semibold tabular-nums text-text-faint">
              · {tasks.length + notes.length}
            </span>
            <span className="flex-1" />
          </>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand node rail" : "Collapse node rail"}
          title={collapsed ? "Expand rail" : "Collapse rail"}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <IconPanelLeft size={12} />
        </button>
      </header>
      <RailNodeList
        tasks={tasks}
        notes={notes}
        selectedNodeId={selectedNodeId}
        hoveredId={hoveredId}
        onHover={onHover}
        onSelectTask={onSelect}
        onSelectNote={onSelectNote}
        stageMap={stageMap}
        collapsed={collapsed}
      />
    </aside>
  );
}

export default MiniTaskRail;
