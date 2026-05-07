'use client';

import { useMemo } from 'react';
import type { Task, TaskEdge } from '@/lib/db/schema';
import type { TaskGraphSlim } from '@/lib/data/views';
import type { TaskStatus } from '@/lib/types';
import { isPlannable, isReady, buildStatusMap } from '@/lib/ui/taskState';
import { BundlePreview } from '@/components/workspace/BundlePreview';
import { DetailHeader } from './DetailHeader';
import { DescriptionSection } from './DescriptionSection';
import { CriteriaSection } from './CriteriaSection';
import { DecisionsSection } from './DecisionsSection';
import { RelationshipsSection } from './RelationshipsSection';
import { ExecutionSection } from './ExecutionSection';
import { ActivitySection } from './ActivitySection';
import { SectionHeader } from './SectionHeader';

interface DetailViewProps {
  /** Task UUID. */
  taskId: string;
  /** Current task with composed taskRef. */
  task: Task & { taskRef: string };
  /** Project UUID. */
  projectId: string;
  /** Project display name for the breadcrumb. */
  projectName: string;
  /** All project edges — used by the bundle preview to derive neighbors. */
  allEdges: TaskEdge[];
  /** Edges connected to this task. */
  edges: TaskEdge[];
  /** All tasks in the project (slim) — feeds the status map for ready/plannable derivation. */
  allTasks: TaskGraphSlim[];
  /** Map of task IDs to title/status/taskRef. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  /** Whether the property rail drawer is open (1024–1279px / mobile). */
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
}

/**
 * Single scrollable detail column for the workspace. Replaces the
 * tabbed DetailPanel: every tab's behaviour now appears as a stacked
 * section so operators can scan the task without a tab dance.
 *
 * @param props - Detail view configuration.
 * @returns Detail column element.
 */
export function DetailView({
  taskId,
  task,
  projectId,
  projectName,
  allEdges,
  edges,
  allTasks,
  taskMap,
  drawerOpen,
  onToggleDrawer,
  onClose,
  onSelectNode,
  onGraphChange,
  navigatorClosed,
  onToggleNavigator,
}: DetailViewProps) {
  const statusMap = useMemo(() => buildStatusMap(allTasks), [allTasks]);
  const ready = useMemo(() => isReady(task, statusMap, allEdges), [task, statusMap, allEdges]);
  const plannable = useMemo(
    () =>
      isPlannable(
        {
          id: task.id,
          status: task.status,
          hasDescription: !!task.description?.trim(),
          hasCriteria: (task.acceptanceCriteria ?? []).length > 0,
        },
        statusMap,
        allEdges,
      ),
    [task, statusMap, allEdges],
  );

  const prerequisites = useMemo(() => buildPrerequisites(taskId, allEdges, taskMap), [taskId, allEdges, taskMap]);
  const neighbors = useMemo(() => buildNeighbors(taskId, allEdges, taskMap), [taskId, allEdges, taskMap]);
  const downstream = useMemo(() => buildDownstream(taskId, allEdges, taskMap), [taskId, allEdges, taskMap]);

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        taskId={taskId}
        taskRef={task.taskRef}
        title={task.title}
        status={task.status}
        projectName={projectName}
        drawerOpen={drawerOpen}
        onToggleDrawer={onToggleDrawer}
        onClose={onClose}
        onGraphChange={onGraphChange}
        navigatorClosed={navigatorClosed}
        onToggleNavigator={onToggleNavigator}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-8 pt-6 pb-[60px]">
          <DescriptionSection
            taskId={taskId}
            description={task.description}
            onGraphChange={onGraphChange}
          />

          <CriteriaSection
            taskId={taskId}
            criteria={task.acceptanceCriteria}
            onGraphChange={onGraphChange}
          />

          <section className="mb-7">
            <SectionHeader label="Context bundle preview" badge={<BundleStageBadge status={task.status} isReady={ready} isPlannable={plannable} />} />
            <BundlePreview
              taskId={taskId}
              projectId={projectId}
              status={task.status}
              isReady={ready}
              isPlannable={plannable}
              spec={task.description}
              criteria={task.acceptanceCriteria ?? []}
              plan={task.implementationPlan}
              prerequisites={prerequisites}
              neighbors={neighbors}
              downstream={downstream}
              decisions={task.decisions ?? []}
              files={Array.from(new Set((task.files as string[] | null) ?? []))}
              executionRecord={task.executionRecord}
              onSelectTask={onSelectNode}
            />
          </section>

          <DecisionsSection
            taskId={taskId}
            decisions={task.decisions}
            onGraphChange={onGraphChange}
          />

          <RelationshipsSection
            taskId={taskId}
            edges={edges}
            taskMap={taskMap}
            onSelectNode={onSelectNode}
            onGraphChange={onGraphChange}
          />

          <ExecutionSection record={task.executionRecord} />

          <ActivitySection history={task.history} />
        </div>
      </div>
    </div>
  );
}

interface BundleStageBadgeProps {
  /** Active task status. */
  status: TaskStatus;
  /** True when a `planned` task has all effective deps done. */
  isReady: boolean;
  /** True when a `draft` task has the description + criteria + done deps to be planned. */
  isPlannable: boolean;
}

/** Caption shown for each resolved lifecycle stage — matches the `lib/context` builder name used by BundlePreview. */
const BUNDLE_BADGE_CAPTION: Record<string, string> = {
  draft:       'planning',
  plannable:   'planning',
  planned:     'working',
  ready:       'planning',
  in_progress: 'agent',
  done:        'execution',
  cancelled:   'execution',
};

/**
 * Mono lowercase tag rendered next to the "Context bundle preview" section
 * label — surfaces the active bundle shape (including `plannable` and
 * `ready` sub-stages) so the operator sees what the agent will receive
 * at this point in the lifecycle.
 *
 * @param props - Badge props.
 * @returns Inline badge element.
 */
function BundleStageBadge({ status, isReady, isPlannable }: BundleStageBadgeProps) {
  let stage: string = status;
  if (status === 'draft' && isPlannable) stage = 'plannable';
  else if (status === 'planned' && isReady) stage = 'ready';
  return (
    <span className="inline-flex items-center rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-medium lowercase tracking-wider text-accent-light">
      {BUNDLE_BADGE_CAPTION[stage] ?? 'working'}
    </span>
  );
}

interface BundleNeighbor {
  /** Task UUID. */
  id: string;
  /** Composed identifier. */
  taskRef: string;
  /** Display title. */
  title: string;
  /** Schema status. */
  status: string;
}

/**
 * Build the upstream bundle neighbors (`depends_on` outgoing).
 *
 * @param taskId - Current task UUID.
 * @param edges - All project edges.
 * @param taskMap - Map of task IDs to title/status/taskRef.
 * @returns List of upstream bundle neighbors.
 */
function buildPrerequisites(
  taskId: string,
  edges: TaskEdge[],
  taskMap: Map<string, { title: string; status: string; taskRef: string }>,
): BundleNeighbor[] {
  const out: BundleNeighbor[] = [];
  for (const edge of edges) {
    if (edge.sourceTaskId !== taskId || edge.edgeType !== 'depends_on') continue;
    const info = taskMap.get(edge.targetTaskId);
    if (!info) continue;
    out.push({ id: edge.targetTaskId, taskRef: info.taskRef, title: info.title, status: info.status });
  }
  return out;
}

/**
 * Build `relates_to` 1-hop siblings — surfaces the agent's "neighbors" lane.
 *
 * @param taskId - Current task UUID.
 * @param edges - All project edges.
 * @param taskMap - Map of task IDs to title/status/taskRef.
 * @returns List of related siblings.
 */
function buildNeighbors(
  taskId: string,
  edges: TaskEdge[],
  taskMap: Map<string, { title: string; status: string; taskRef: string }>,
): BundleNeighbor[] {
  const out: BundleNeighbor[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.edgeType !== 'relates_to') continue;
    const otherId = edge.sourceTaskId === taskId
      ? edge.targetTaskId
      : edge.targetTaskId === taskId
        ? edge.sourceTaskId
        : null;
    if (!otherId || seen.has(otherId)) continue;
    const info = taskMap.get(otherId);
    if (!info) continue;
    seen.add(otherId);
    out.push({ id: otherId, taskRef: info.taskRef, title: info.title, status: info.status });
  }
  return out;
}

/**
 * Build downstream `depends_on` consumers — the tasks blocked by this one.
 *
 * @param taskId - Current task UUID.
 * @param edges - All project edges.
 * @param taskMap - Map of task IDs to title/status/taskRef.
 * @returns List of downstream consumers.
 */
function buildDownstream(
  taskId: string,
  edges: TaskEdge[],
  taskMap: Map<string, { title: string; status: string; taskRef: string }>,
): BundleNeighbor[] {
  const out: BundleNeighbor[] = [];
  for (const edge of edges) {
    if (edge.edgeType !== 'depends_on' || edge.targetTaskId !== taskId) continue;
    const info = taskMap.get(edge.sourceTaskId);
    if (!info) continue;
    out.push({ id: edge.sourceTaskId, taskRef: info.taskRef, title: info.title, status: info.status });
  }
  return out;
}

export default DetailView;
