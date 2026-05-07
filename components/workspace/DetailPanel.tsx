'use client';

import { DetailView } from './detail/DetailView';
import type { Task, TaskEdge } from '@/lib/db/schema';
import type { TaskGraphSlim } from '@/lib/data/views';

interface DetailPanelProps {
  /** Task UUID. */
  taskId: string;
  /** Project UUID. */
  projectId: string;
  /** Current task with composed taskRef. */
  task: Task & { taskRef: string };
  /** Project display name (breadcrumb). */
  parentName: string;
  /** Edges connected to this task. */
  edges: TaskEdge[];
  /** All edges in the project — used by the bundle preview to derive neighbors. */
  allEdges: TaskEdge[];
  /** All tasks in the project (slim) — feeds the bundle preview's ready/plannable derivation. */
  allTasks: TaskGraphSlim[];
  /** Map of task IDs to title/status/taskRef. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
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
  edges,
  allEdges,
  allTasks,
  taskMap,
  drawerOpen,
  onToggleDrawer,
  onClose,
  onSelectNode,
  onGraphChange,
  navigatorClosed,
  onToggleNavigator,
  className = '',
}: DetailPanelProps) {
  return (
    <div className={`h-full ${className}`}>
      <DetailView
        taskId={taskId}
        projectId={projectId}
        task={task}
        projectName={parentName}
        allEdges={allEdges}
        edges={edges}
        allTasks={allTasks}
        taskMap={taskMap}
        drawerOpen={drawerOpen}
        onToggleDrawer={onToggleDrawer}
        onClose={onClose}
        onSelectNode={onSelectNode}
        onGraphChange={onGraphChange}
        navigatorClosed={navigatorClosed}
        onToggleNavigator={onToggleNavigator}
      />
    </div>
  );
}

export default DetailPanel;
