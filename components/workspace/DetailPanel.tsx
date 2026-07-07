"use client";

import { DetailView } from "./detail/DetailView";
import type {
  TaskEdgeRef,
  TaskFull,
  TaskGraphEdge,
  TaskGraphSlim,
} from "@/lib/data/views";

interface DetailPanelProps {
  /** Task UUID. */
  taskId: string;
  /** Project UUID. */
  projectId: string;
  /** Current task with composed taskRef, assignees, and links. */
  task: TaskFull;
  /** Project display name (breadcrumb). */
  parentName: string;
  /** Project description — feeds the bundle preview's project drawer. */
  parentDescription: string | null;
  /** Edges connected to this task. */
  edges: TaskEdgeRef[];
  /** All slim edges in the project — used by the bundle preview to derive neighbors. */
  allEdges: TaskGraphEdge[];
  /** All tasks in the project (slim) — feeds the bundle preview's ready/plannable derivation. */
  allTasks: TaskGraphSlim[];
  /** Map of task IDs to title/status/taskRef. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  /** Project prefix (e.g. `MYM`) for the linked-note ref chip. */
  projectIdentifier: string;
  /** Open a linked note on the Notes surface. */
  onOpenNote: (noteId: string) => void;
  /** Whether the property rail drawer is open. */
  drawerOpen: boolean;
  /** Toggle the drawer. */
  onToggleDrawer: () => void;
  /** Close the detail panel. */
  onClose: () => void;
  /** Open another task. */
  onSelectNode: (taskId: string) => void;
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
  /** Whether the structure navigator pane is hidden (xl-only structure mode). */
  navigatorClosed?: boolean;
  /** Toggle the navigator open/closed; when omitted the panel-toggle is hidden. */
  onToggleNavigator?: () => void;
  /** Whether the right-side properties rail is currently visible (graph overlay only). */
  propRailOpen?: boolean;
  /** Toggle the properties rail open/closed; when omitted the toggle is hidden. */
  onTogglePropRail?: () => void;
  /**
   * When true the header is rendered from placeholder data and the body
   * withholds its content until the full detail fetch resolves.
   */
  isBodyLoading?: boolean;
  /**
   * When true the body renders skeleton blocks. Derived from
   * `isBodyLoading` via `useSkeletonVisibility` (show delay + minimum
   * visible hold) so fast fetches never flash a skeleton.
   */
  showBodySkeleton?: boolean;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Thin shim — keeps the public DetailPanel name stable so the workspace
 * page imports don't change, while the rendered tree becomes a single
 * scrollable {@link DetailView}.
 *
 * @param props - Detail panel configuration.
 * @returns Detail column.
 */
export function DetailPanel({
  taskId,
  projectId,
  task,
  parentName,
  parentDescription,
  edges,
  allEdges,
  allTasks,
  taskMap,
  projectIdentifier,
  onOpenNote,
  drawerOpen,
  onToggleDrawer,
  onClose,
  onSelectNode,
  onGraphChange,
  navigatorClosed,
  onToggleNavigator,
  propRailOpen,
  onTogglePropRail,
  isBodyLoading = false,
  showBodySkeleton = false,
  className = "",
}: DetailPanelProps) {
  return (
    <div className={`h-full ${className}`}>
      <DetailView
        taskId={taskId}
        projectId={projectId}
        task={task}
        projectName={parentName}
        projectDescription={parentDescription}
        allEdges={allEdges}
        edges={edges}
        allTasks={allTasks}
        taskMap={taskMap}
        projectIdentifier={projectIdentifier}
        onOpenNote={onOpenNote}
        drawerOpen={drawerOpen}
        onToggleDrawer={onToggleDrawer}
        onClose={onClose}
        onSelectNode={onSelectNode}
        onGraphChange={onGraphChange}
        navigatorClosed={navigatorClosed}
        onToggleNavigator={onToggleNavigator}
        propRailOpen={propRailOpen}
        onTogglePropRail={onTogglePropRail}
        isBodyLoading={isBodyLoading}
        showBodySkeleton={showBodySkeleton}
      />
    </div>
  );
}

export default DetailPanel;
