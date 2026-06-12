"use client";

import { useMemo, type CSSProperties } from "react";
import type {
  TaskEdgeRef,
  TaskFull,
  TaskGraphEdge,
  TaskGraphSlim,
  TaskLinkRef,
} from "@/lib/data/views";
import type { TaskState } from "@/lib/data/task";
import type { TaskStatus } from "@/lib/types";
import {
  BundlePreview,
  type BundleConnectedEdge,
} from "@/components/workspace/BundlePreview";
import {
  BUNDLE_LABEL_BY_STAGE,
  resolveStage,
} from "@/components/workspace/bundle-tables";
import { DetailHeader } from "./DetailHeader";
import { DescriptionSection } from "./DescriptionSection";
import { CriteriaSection } from "./CriteriaSection";
import { DecisionsSection } from "./DecisionsSection";
import { LinksSection } from "./LinksSection";
import { RelationshipsSection } from "./RelationshipsSection";
import { ExecutionSection } from "./ExecutionSection";
import { ActivitySection } from "./ActivitySection";
import { SectionHeader } from "./SectionHeader";

interface DetailViewProps {
  /** Task UUID. */
  taskId: string;
  /**
   * Current task with composed taskRef and full server-side projections
   * (assignees, links). The `/api/task/[taskId]` route returns the
   * {@link TaskFull} shape; older callers fed only `Task & { taskRef }`,
   * so `links` and `assignees` are typed nullable on this surface and
   * the sections below default to `[]`.
   */
  task: TaskFull;
  /** Project UUID. */
  projectId: string;
  /** Project display name for the breadcrumb. */
  projectName: string;
  /** All slim project edges — used by the bundle preview to derive neighbors. */
  allEdges: TaskGraphEdge[];
  /** Edges connected to this task. */
  edges: TaskEdgeRef[];
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
  /** Whether the right-side properties rail is currently visible (graph overlay only). */
  propRailOpen?: boolean;
  /** Toggle the properties rail open/closed; when omitted the toggle is hidden. */
  onTogglePropRail?: () => void;
  /**
   * When true the header is rendered from seeded placeholder data and the
   * body withholds its content while the full task fetch resolves. Set
   * from `isPlaceholderData` on the detail `useQuery`.
   */
  isBodyLoading?: boolean;
  /**
   * When true the body renders skeleton blocks. Lags `isBodyLoading` via
   * `useSkeletonVisibility`: fast fetches resolve before the show delay
   * and swap straight to content; slow fetches hold the skeleton for a
   * minimum beat so it never flash-swaps mid-entrance.
   */
  showBodySkeleton?: boolean;
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
  propRailOpen,
  onTogglePropRail,
  isBodyLoading = false,
  showBodySkeleton = false,
}: DetailViewProps) {
  // Read the server-derived `state` for this task off the slim payload —
  // the same projection the canvas, rail, and structure list see. Falls
  // back to schema status only if the task doesn't appear in `allTasks`,
  // which shouldn't happen for any selected task in practice.
  const currentState = useMemo(
    () => allTasks.find((t) => t.id === taskId)?.state,
    [allTasks, taskId],
  );

  const prerequisites = useMemo(
    () => buildPrerequisites(taskId, allEdges, taskMap),
    [taskId, allEdges, taskMap],
  );
  const connected = useMemo(
    () => buildConnected(taskId, edges, taskMap),
    [taskId, edges, taskMap],
  );
  const downstream = useMemo(
    () => buildDownstream(taskId, allEdges, taskMap),
    [taskId, allEdges, taskMap],
  );

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
        propRailOpen={propRailOpen}
        onTogglePropRail={onTogglePropRail}
      />

      <div className="flex-1 overflow-y-auto">
        {showBodySkeleton ? (
          <DetailBodySkeleton />
        ) : isBodyLoading ? null : (
          <div className="rise-in mx-auto max-w-[720px] px-4 pt-6 pb-[60px] sm:px-6 lg:px-8">
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
              <SectionHeader
                label="Context bundle preview"
                badge={
                  <BundleStageBadge
                    status={task.status}
                    state={currentState}
                  />
                }
              />
              <BundlePreview
                taskId={taskId}
                projectId={projectId}
                status={task.status}
                state={currentState}
                projectName={projectName}
                spec={task.description}
                tags={(task.tags as string[] | null) ?? []}
                priority={task.priority}
                estimate={task.estimate}
                assignees={task.assignees ?? []}
                criteria={task.acceptanceCriteria ?? []}
                plan={task.implementationPlan}
                prerequisites={prerequisites}
                connected={connected}
                downstream={downstream}
                decisions={task.decisions ?? []}
                files={Array.from(
                  new Set((task.files as string[] | null) ?? []),
                )}
                links={(task.links as TaskLinkRef[] | undefined) ?? []}
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

            <LinksSection
              taskId={taskId}
              links={(task.links as TaskLinkRef[] | undefined) ?? []}
              onGraphChange={onGraphChange}
            />

            <ExecutionSection record={task.executionRecord} />

            <ActivitySection history={task.history} />
          </div>
        )}
      </div>
    </div>
  );
}

interface BundleStageBadgeProps {
  /** Schema task status. */
  status: TaskStatus;
  /** Server-derived state, when the task appears in the slim payload. */
  state?: TaskState;
}

/**
 * Mono lowercase tag rendered next to the "Context bundle preview" section
 * label — surfaces the bundle the next lifecycle consumer receives at this
 * point in the lifecycle.
 *
 * @param props - Badge props.
 * @returns Inline badge element.
 */
function BundleStageBadge({ status, state }: BundleStageBadgeProps) {
  return (
    <span className="inline-flex items-center rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-medium lowercase tracking-wider text-accent-light">
      {BUNDLE_LABEL_BY_STAGE[resolveStage(status, state)]}
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
 * @param edges - All slim project edges.
 * @param taskMap - Map of task IDs to title/status/taskRef.
 * @returns List of upstream bundle neighbors.
 */
function buildPrerequisites(
  taskId: string,
  edges: TaskGraphEdge[],
  taskMap: Map<string, { title: string; status: string; taskRef: string }>,
): BundleNeighbor[] {
  const out: BundleNeighbor[] = [];
  for (const edge of edges) {
    if (edge.sourceTaskId !== taskId || edge.edgeType !== "depends_on")
      continue;
    if (edge.targetTaskId === taskId) continue;
    const info = taskMap.get(edge.targetTaskId);
    if (!info) continue;
    out.push({
      id: edge.targetTaskId,
      taskRef: info.taskRef,
      title: info.title,
      status: info.status,
    });
  }
  return out;
}

/**
 * Build all 1-hop connected edges (every type, both directions) for the
 * bundle preview's connected row.
 *
 * @param taskId - Current task UUID.
 * @param edges - Edges connected to this task (with notes).
 * @param taskMap - Map of task IDs to title/status/taskRef.
 * @returns Connected edge rows.
 */
function buildConnected(
  taskId: string,
  edges: TaskEdgeRef[],
  taskMap: Map<string, { title: string; status: string; taskRef: string }>,
): BundleConnectedEdge[] {
  const out: BundleConnectedEdge[] = [];
  for (const e of edges) {
    const direction = e.sourceTaskId === taskId ? "outgoing" : "incoming";
    const otherId = direction === "outgoing" ? e.targetTaskId : e.sourceTaskId;
    if (otherId === taskId) continue;
    const info = taskMap.get(otherId);
    if (!info) continue;
    out.push({
      id: otherId,
      taskRef: info.taskRef,
      title: info.title,
      status: info.status,
      edgeType: e.edgeType,
      direction,
      note: e.note ?? null,
    });
  }
  return out;
}

/**
 * Build downstream `depends_on` consumers — the tasks blocked by this one.
 *
 * @param taskId - Current task UUID.
 * @param edges - All slim project edges.
 * @param taskMap - Map of task IDs to title/status/taskRef.
 * @returns List of downstream consumers.
 */
function buildDownstream(
  taskId: string,
  edges: TaskGraphEdge[],
  taskMap: Map<string, { title: string; status: string; taskRef: string }>,
): BundleNeighbor[] {
  const out: BundleNeighbor[] = [];
  for (const edge of edges) {
    if (edge.edgeType !== "depends_on" || edge.targetTaskId !== taskId)
      continue;
    if (edge.sourceTaskId === taskId) continue;
    const info = taskMap.get(edge.sourceTaskId);
    if (!info) continue;
    out.push({
      id: edge.sourceTaskId,
      taskRef: info.taskRef,
      title: info.title,
      status: info.status,
    });
  }
  return out;
}

/**
 * Build an inline style from skeleton CSS custom properties
 * (`--skeleton-delay`, `--skeleton-radius`, `--skeleton-base`).
 *
 * @param vars - Custom-property map applied to a skeleton element.
 * @returns The map typed as a React inline style.
 */
function skeletonVars(
  vars: Record<`--skeleton-${string}`, string>,
): CSSProperties {
  return vars as CSSProperties;
}

/**
 * The five bundle-preview section tints (spec / prerequisites / neighbors /
 * decisions / files), previewed by the bundle skeleton bars.
 */
const BUNDLE_SKELETON_BARS: { tint: string; width: string }[] = [
  { tint: "var(--color-accent)", width: "w-full" },
  { tint: "var(--color-planned)", width: "w-5/6" },
  { tint: "var(--color-relates)", width: "w-2/3" },
  { tint: "var(--color-progress)", width: "w-1/2" },
  { tint: "var(--color-accent-2)", width: "w-2/5" },
];

/**
 * Skeleton placeholder for the detail body while `isPlaceholderData` is
 * true. Mirrors the anatomy of the real body — description lines, criteria
 * checklist rows, the color-coded bundle-preview card, decisions, and
 * relationship chips — so the layout stays stable when the full fetch
 * resolves. Sections rise in staggered (fade + 4px y-slide) and a
 * shared sheen wave travels down the bars via `--skeleton-delay`.
 *
 * @returns Skeleton element rendered inside the scrollable body area.
 */
function DetailBodySkeleton() {
  return (
    <div className="mx-auto max-w-[720px] px-4 pt-6 pb-[60px] sm:px-6 lg:px-8">
      <section
        className="rise-in mb-7"
        style={skeletonVars({ "--skeleton-delay": "0ms" })}
      >
        <div className="skeleton-bar mb-3 h-2.5 w-20" />
        <div className="space-y-2">
          <div className="skeleton-bar h-3 w-full" />
          <div className="skeleton-bar h-3 w-11/12" />
          <div className="skeleton-bar h-3 w-2/3" />
        </div>
      </section>

      <section
        className="rise-in mb-7"
        style={skeletonVars({ "--skeleton-delay": "70ms" })}
      >
        <div className="skeleton-bar mb-3 h-2.5 w-32" />
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div
              className="skeleton-bar h-3.5 w-3.5 shrink-0"
              style={skeletonVars({ "--skeleton-radius": "9999px" })}
            />
            <div className="skeleton-bar h-3 w-3/5" />
          </div>
          <div className="flex items-center gap-2">
            <div
              className="skeleton-bar h-3.5 w-3.5 shrink-0"
              style={skeletonVars({ "--skeleton-radius": "9999px" })}
            />
            <div className="skeleton-bar h-3 w-2/5" />
          </div>
        </div>
      </section>

      <section
        className="rise-in mb-7"
        style={skeletonVars({ "--skeleton-delay": "140ms" })}
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="skeleton-bar h-2.5 w-36" />
          <div
            className="skeleton-bar h-4 w-14"
            style={skeletonVars({ "--skeleton-radius": "9999px" })}
          />
        </div>
        <div className="rounded-lg border border-border bg-surface/40 p-4">
          <div className="space-y-3">
            {BUNDLE_SKELETON_BARS.map((bar, i) => (
              <div
                key={bar.tint}
                className={`skeleton-bar h-2 ${bar.width}`}
                style={skeletonVars({
                  "--skeleton-delay": `${140 + i * 40}ms`,
                  "--skeleton-base": `color-mix(in srgb, ${bar.tint} 16%, transparent)`,
                })}
              />
            ))}
          </div>
        </div>
      </section>

      <section
        className="rise-in mb-7"
        style={skeletonVars({ "--skeleton-delay": "210ms" })}
      >
        <div className="skeleton-bar mb-3 h-2.5 w-24" />
        <div className="space-y-2">
          <div className="skeleton-bar h-3 w-4/5" />
          <div className="skeleton-bar h-3 w-1/2" />
        </div>
      </section>

      <section
        className="rise-in"
        style={skeletonVars({ "--skeleton-delay": "280ms" })}
      >
        <div className="skeleton-bar mb-3 h-2.5 w-32" />
        <div className="flex items-center gap-2">
          <div
            className="skeleton-bar h-6 w-24"
            style={skeletonVars({ "--skeleton-radius": "6px" })}
          />
          <div
            className="skeleton-bar h-6 w-28"
            style={skeletonVars({ "--skeleton-radius": "6px" })}
          />
          <div
            className="skeleton-bar h-6 w-20"
            style={skeletonVars({ "--skeleton-radius": "6px" })}
          />
        </div>
      </section>
    </div>
  );
}

export default DetailView;
