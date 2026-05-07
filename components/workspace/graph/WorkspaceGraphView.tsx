'use client';

import dynamic from 'next/dynamic';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ViewTabs } from '@/components/shared/ViewTabs';
import { IconGraph, IconList } from '@/components/shared/icons';
import type { TaskEdge } from '@/lib/db/schema';
import type { TaskGraphSlim } from '@/lib/data/views';
import { MiniTaskRail } from './MiniTaskRail';
import { GraphHoverCard } from './GraphHoverCard';
import { EdgeFilterPills, edgeFilterToHidden, type EdgeFilterValue } from './EdgeFilterPills';
import { StatusLegend } from './StatusLegend';

/** Dynamic import — the canvas-based ForceGraph is client-only. */
const ForceGraph = dynamic(
  () => import('@/components/graph/ForceGraph').then((m) => m.ForceGraph),
  { ssr: false },
);

/** Width of the detail+proprail slide-over panel. */
const DETAIL_OVERLAY_WIDTH = 760;

interface WorkspaceGraphViewProps {
  /** @param tasks - Project tasks (slim, already enriched with `taskRef`). */
  tasks: TaskGraphSlim[];
  /** @param edges - Project edges. */
  edges: TaskEdge[];
  /** @param selectedNodeId - Currently selected task id. */
  selectedNodeId: string | null;
  /** @param onSelectNode - Open a task — mirrors the structure-view handler. */
  onSelectNode: (id: string) => void;
  /** @param onDeselect - Click empty canvas → clear selection. */
  onDeselect: () => void;
  /** @param onSwitchToStructure - Click the Structure tab in the canvas overlay. */
  onSwitchToStructure: () => void;
  /**
   * @param detailSlot - When set, rendered inside the slide-over panel
   *   alongside `propRailSlot`. Typically the project's `<DetailPanel />`.
   *   When omitted, no slide-over renders and the canvas stays full bleed.
   */
  detailSlot?: ReactNode;
  /** @param propRailSlot - The `<PropRail />` rendered next to `detailSlot`. */
  propRailSlot?: ReactNode;
}

/**
 * Workspace graph view — left rail of every node + force-directed canvas with
 * floating chrome (view tabs, edge filter pills, status legend, zoom controls,
 * hover card). Detail and property rail are rendered as a motion slide-over
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
  tasks,
  edges,
  selectedNodeId,
  onSelectNode,
  onDeselect,
  onSwitchToStructure,
  detailSlot,
  propRailSlot,
}: WorkspaceGraphViewProps) {
  const [hoveredFromRail, setHoveredFromRail] = useState<string | null>(null);
  const [hoveredOnCanvas, setHoveredOnCanvas] = useState<string | null>(null);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(() => new Set());
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilterValue>('all');

  const hiddenEdgeTypes = useMemo(() => edgeFilterToHidden(edgeFilter), [edgeFilter]);

  const toggleStatus = useCallback((status: string) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  // Filter the rail in lockstep with the canvas — what's listed = what's drawn.
  const visibleTasks = useMemo(
    () => tasks.filter((t) => !hiddenStatuses.has(t.status)),
    [tasks, hiddenStatuses],
  );

  // Rail wins; canvas is the fallback. Hover card is suppressed once a task
  // is selected — the detail panel is the canonical view at that point.
  const hoveredId = hoveredFromRail ?? hoveredOnCanvas;
  const showHoverCard = !selectedNodeId && hoveredId !== null;
  const hoveredTask = showHoverCard
    ? tasks.find((t) => t.id === hoveredId) ?? null
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
  const rightInset = overlayOpen ? DETAIL_OVERLAY_WIDTH : 0;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <MiniTaskRail
        tasks={visibleTasks}
        selectedNodeId={selectedNodeId}
        hoveredId={hoveredFromRail}
        onHover={setHoveredFromRail}
        onSelect={onSelectNode}
      />

      <div className="relative min-w-0 flex-1 overflow-hidden bg-base">
        <ForceGraph
          tasks={tasks}
          edges={edges}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onDeselect={onDeselect}
          hoveredIdHint={hoveredFromRail}
          hiddenStatuses={hiddenStatuses}
          hiddenEdgeTypes={hiddenEdgeTypes}
          rightInset={rightInset}
          onHoverNode={setHoveredOnCanvas}
        />

        {/* Top-left: Structure ↔ Graph view tabs.
            The graph already has its own minirail collapse toggle, so we
            don't double up with another panel toggle here — the structure
            mode owns the navigator-fold affordance via the detail header. */}
        <div className="absolute left-3 top-3 z-10">
          <ViewTabs
            activeId="graph"
            onChange={(id) => {
              if (id === 'structure') onSwitchToStructure();
            }}
            tabs={[
              { id: 'structure', label: 'Structure', icon: <IconList size={11} /> },
              { id: 'graph',     label: 'Graph',     icon: <IconGraph size={11} /> },
            ]}
          />
        </div>

        {/* Top-right chrome — rides the overlay edge instead of getting eaten
            by it. Hover card stays suppressed while a task is selected (the
            detail panel is canonical at that point); pills remain available
            so edge filtering still works alongside the open task. */}
        <div
          className="absolute top-3 z-10"
          style={{
            right: 12 + rightInset,
            transition: 'right 240ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {showHoverCard && hoveredTask ? (
            <GraphHoverCard
              task={hoveredTask}
              upstreamCount={hoverCounts.upstream}
              downstreamCount={hoverCounts.downstream}
              onOpen={() => onSelectNode(hoveredTask.id)}
            />
          ) : (
            <EdgeFilterPills value={edgeFilter} onChange={setEdgeFilter} />
          )}
        </div>

        {/* Bottom-left: status legend (toggle filters) */}
        <StatusLegend hiddenStatuses={hiddenStatuses} onToggleStatus={toggleStatus} />

        {/* Detail slide-over — pinned right; canvas underneath stays at full
            width so the graph remains the primary surface. */}
        <AnimatePresence>
          {overlayOpen && (
            <motion.div
              key="graph-detail-overlay"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="absolute right-0 top-0 bottom-0 z-20 flex bg-base shadow-[var(--shadow-float)]"
              style={{ width: DETAIL_OVERLAY_WIDTH }}
              role="region"
              aria-label="Task detail"
            >
              <div className="w-px bg-gradient-to-b from-border-strong via-border to-transparent" />
              <div className="flex min-w-0 flex-1 flex-col">{detailSlot}</div>
              {propRailSlot}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default WorkspaceGraphView;
