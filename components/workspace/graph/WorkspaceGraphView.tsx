"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  NoteGraphEdge,
  NoteGraphSlim,
  NoteTaskGraphEdge,
  TaskGraphEdge,
  TaskGraphSlim,
} from "@/lib/data/views";
import { MiniTaskRail } from "./MiniTaskRail";
import { GraphHoverCard } from "./GraphHoverCard";
import {
  EdgeFilterPills,
  edgeFilterToHidden,
  type EdgeFilterValue,
} from "./EdgeFilterPills";
import { StatusLegend } from "./StatusLegend";

/** Dynamic import — the canvas-based ForceGraph is client-only. */
const ForceGraph = dynamic(
  () => import("@/components/graph/ForceGraph").then((m) => m.ForceGraph),
  { ssr: false },
);

/** Slide-over width with the property rail visible (default state). */
const OVERLAY_W_FULL = 760;
/** Slide-over width when the property rail is collapsed — detail panel only. */
const OVERLAY_W_DETAIL = 480;
/** Animation timing — matches the detail-panel slide-in from `motion.div`. */
const OVERLAY_TRANSITION = { duration: 0.24, ease: [0.16, 1, 0.3, 1] } as const;

interface WorkspaceGraphViewProps {
  /** @param projectId - Stable identifier — keys the position cache so the
   *   simulation reuses its layout across remounts of this view. */
  projectId: string;
  /** @param tasks - Project tasks (slim, already enriched with `taskRef`). */
  tasks: TaskGraphSlim[];
  /** @param edges - Project edges in slim graph shape. */
  edges: TaskGraphEdge[];
  /** @param notes - Project notes in slim graph shape. */
  notes: NoteGraphSlim[];
  /** @param noteLinks - Note-to-note edges in slim graph shape. */
  noteLinks: NoteGraphEdge[];
  /** @param noteTaskLinks - Note-to-task edges in slim graph shape. */
  noteTaskLinks: NoteTaskGraphEdge[];
  /** @param selectedNodeId - Currently selected task id. */
  selectedNodeId: string | null;
  /** @param onSelectNode - Open a task — mirrors the structure-view handler. */
  onSelectNode: (id: string) => void;
  /** @param onSelectNote - Open a note on the notes surface via the
   *   `?view=notes&note=<id>` selection path. */
  onSelectNote: (id: string) => void;
  /** @param onDeselect - Click empty canvas → clear selection. */
  onDeselect: () => void;
  /**
   * @param detailSlot - When set, rendered inside the slide-over panel
   *   alongside `propRailSlot`. Typically the project's `<DetailPanel />`.
   *   When omitted, no slide-over renders and the canvas stays full bleed.
   */
  detailSlot?: ReactNode;
  /** @param propRailSlot - The `<PropRail />` rendered next to `detailSlot`. */
  propRailSlot?: ReactNode;
  /**
   * @param propRailOpen - Controls the property rail's visibility inside the
   *   slide-over. When `false`, the overlay shrinks to detail-only width and
   *   the canvas reclaims the freed pixels (the chrome chips get room to
   *   breathe). Defaults to `true`.
   */
  propRailOpen?: boolean;
}

/**
 * Workspace graph view — left rail of every node + force-directed canvas with
 * floating chrome (edge filter pills, status legend, zoom controls, hover
 * card). Detail and property rail are rendered as a motion slide-over
 * pinned to the right edge so the canvas keeps its full layout — selection
 * just adds a layer instead of reflowing the page.
 *
 * Hover state has two sources — pointer hover on the canvas and pointer hover
 * in the rail — merged into a single `hoveredId` for rendering the preview
 * card. The rail value is also passed back into the canvas as `hoveredIdHint`
 * so a row hover lights up the matching node visually. When a task is
 * selected the camera animates to centre that node inside the visible canvas
 * region (offset by the slide-over width).
 *
 * @param props - View configuration.
 * @returns Rail + canvas layout filling its parent.
 */
export function WorkspaceGraphView({
  projectId,
  tasks,
  edges,
  notes,
  noteLinks,
  noteTaskLinks,
  selectedNodeId,
  onSelectNode,
  onSelectNote,
  onDeselect,
  detailSlot,
  propRailSlot,
  propRailOpen = true,
}: WorkspaceGraphViewProps) {
  const [hoveredFromRail, setHoveredFromRail] = useState<string | null>(null);
  const [hoveredOnCanvas, setHoveredOnCanvas] = useState<string | null>(null);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(
    () => new Set(),
  );
  const [notesHidden, setNotesHidden] = useState(false);
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilterValue>("all");

  const hiddenEdgeTypes = useMemo(
    () => edgeFilterToHidden(edgeFilter),
    [edgeFilter],
  );

  const toggleStatus = useCallback((status: string) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const toggleNotes = useCallback(() => {
    setNotesHidden((prev) => !prev);
  }, []);

  // Filter the rail in lockstep with the canvas — what's listed = what's drawn.
  const visibleTasks = useMemo(
    () => tasks.filter((t) => !hiddenStatuses.has(t.status)),
    [tasks, hiddenStatuses],
  );

  // Derived stage map — only the sub-stages (`plannable` / `ready`) that
  // override the schema status visually. Server-side `getProjectGraphSlim`
  // already computed `task.state` against the project's effective dep
  // graph; we just project it.
  const stageMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) {
      if (t.state === "plannable" || t.state === "ready") m.set(t.id, t.state);
    }
    return m;
  }, [tasks]);

  // Rail wins; canvas is the fallback. Hover card is suppressed once a task
  // is selected — the detail panel is the canonical view at that point.
  const hoveredId = hoveredFromRail ?? hoveredOnCanvas;
  const showHoverCard = !selectedNodeId && hoveredId !== null;
  const hoveredTask = showHoverCard
    ? (tasks.find((t) => t.id === hoveredId) ?? null)
    : null;

  const hoverCounts = useMemo(() => {
    if (!hoveredTask) return { upstream: 0, downstream: 0 };
    let upstream = 0;
    let downstream = 0;
    for (const e of edges) {
      if (e.targetTaskId === hoveredTask.id) upstream += 1;
      if (e.sourceTaskId === hoveredTask.id) downstream += 1;
    }
    return { upstream, downstream };
  }, [hoveredTask, edges]);

  const overlayOpen = Boolean(detailSlot && selectedNodeId);
  const overlayWidth = propRailOpen ? OVERLAY_W_FULL : OVERLAY_W_DETAIL;
  const rightInset = overlayOpen ? overlayWidth : 0;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <MiniTaskRail
        tasks={visibleTasks}
        selectedNodeId={selectedNodeId}
        hoveredId={hoveredFromRail}
        onHover={setHoveredFromRail}
        onSelect={onSelectNode}
        stageMap={stageMap}
        className="max-sm:hidden"
      />

      <div className="relative min-w-0 flex-1 overflow-hidden bg-base">
        <ForceGraph
          projectId={projectId}
          tasks={tasks}
          edges={edges}
          notes={notes}
          noteLinks={noteLinks}
          noteTaskLinks={noteTaskLinks}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onSelectNote={onSelectNote}
          notesHidden={notesHidden}
          onDeselect={onDeselect}
          hoveredIdHint={hoveredFromRail}
          hiddenStatuses={hiddenStatuses}
          hiddenEdgeTypes={hiddenEdgeTypes}
          rightInset={rightInset}
          stageMap={stageMap}
          onHoverNode={setHoveredOnCanvas}
        />

        {/* Top-right chrome — rides the overlay edge instead of getting eaten
            by it. Hover card stays suppressed while a task is selected (the
            detail panel is canonical at that point); pills remain available
            so edge filtering still works alongside the open task. */}
        <div
          className="absolute top-3 z-10"
          style={{
            right: 12 + rightInset,
            transition: "right 240ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          {showHoverCard && hoveredTask ? (
            <GraphHoverCard
              task={hoveredTask}
              stage={stageMap.get(hoveredTask.id)}
              upstreamCount={hoverCounts.upstream}
              downstreamCount={hoverCounts.downstream}
              onOpen={() => onSelectNode(hoveredTask.id)}
            />
          ) : (
            <EdgeFilterPills value={edgeFilter} onChange={setEdgeFilter} />
          )}
        </div>

        {/* Bottom-left: status legend (toggle filters) */}
        <StatusLegend
          hiddenStatuses={hiddenStatuses}
          onToggleStatus={toggleStatus}
          noteCount={notes.length}
          notesHidden={notesHidden}
          onToggleNotes={toggleNotes}
        />

        {/* Detail slide-over — pinned right; canvas underneath stays at full
            width so the graph remains the primary surface. The slide-over's
            width animates between `OVERLAY_W_FULL` (rail open) and
            `OVERLAY_W_DETAIL` (rail closed) so the canvas reclaims pixels
            when the user collapses the property rail. */}
        <AnimatePresence>
          {overlayOpen && (
            <motion.div
              key="graph-detail-overlay"
              initial={{ x: "100%", width: overlayWidth }}
              animate={{ x: 0, width: overlayWidth }}
              exit={{ x: "100%" }}
              transition={OVERLAY_TRANSITION}
              className="absolute right-0 top-0 bottom-0 z-20 flex bg-base shadow-[var(--shadow-float)]"
              role="region"
              aria-label="Task detail"
            >
              <div className="w-px bg-gradient-to-b from-border-strong via-border to-transparent" />
              <div className="flex min-w-0 flex-1 flex-col">{detailSlot}</div>
              <AnimatePresence initial={false}>
                {propRailOpen && propRailSlot && (
                  <motion.div
                    key="graph-prop-rail"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="flex h-full overflow-hidden"
                  >
                    {propRailSlot}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default WorkspaceGraphView;
