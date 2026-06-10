"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TwoPanelLayout } from "@/components/layout/TwoPanelLayout";
import { NavigatorPanel } from "@/components/workspace/NavigatorPanel";
import { DetailPanel } from "@/components/workspace/DetailPanel";
import { PropRail } from "@/components/workspace/detail/PropRail";
import { PropRailDrawer } from "@/components/workspace/detail/PropRailDrawer";
import { WorkspaceGraphView } from "@/components/workspace/graph/WorkspaceGraphView";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { DeferredLoadingSpinner } from "@/components/shared/DeferredLoadingSpinner";
import { projectKeys, taskKeys } from "@/lib/query/keys";
import { fetchProjectGraph, fetchTaskBody } from "@/lib/query/queries";
import type {
  ProjectGraphSlim,
  TaskEdgeRef,
  TaskFullWithEdges,
  TaskGraphSlim,
} from "@/lib/data/views";

/** Workspace view identifier — mirrors the navigator's FilterBar value. */
type WorkspaceView = "structure" | "graph";

/**
 * Resolve the active view from the URL — defaults to `structure`. Mirrors
 * the navigator's own `readView` so the page-level branch and the FilterBar
 * never disagree about which surface is active.
 *
 * @param raw - Raw `view` query param.
 * @returns Workspace view identifier.
 */
function readView(raw: string | null): WorkspaceView {
  return raw === "graph" ? "graph" : "structure";
}

interface WorkspaceClientProps {
  /** Project UUID — taken from the route params on the server shell. */
  projectId: string;
}

/**
 * Client-side workspace shell. Owns selection state and the URL `view`
 * sync; reads the slim graph via TanStack Query (server prefetches; SSE
 * invalidates on remote mutations). The selected-task body fetch lives in
 * {@link WorkspaceBodyWithSelection} so it only registers a Query observer
 * when there is a live, in-graph selection — no `["task", projectId, ""]`
 * placeholder entry pollutes the cache, and a deleted task can't keep
 * triggering 404 refetches via SSE invalidations.
 *
 * @param props - Workspace configuration.
 * @returns Three-column workspace, with graph mode swap when `?view=graph`.
 */
export function WorkspaceClient({ projectId }: WorkspaceClientProps) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = readView(searchParams.get("view"));
  const isXl = useMediaQuery("(min-width: 1280px)", true);

  const { data: graph } = useQuery({
    queryKey: projectKeys.graph(projectId),
    queryFn: fetchProjectGraph(qc, projectId),
  });

  /**
   * Initial task selection sourced from a `?task=<id>` query param — the
   * deep-link shape the global command palette uses to jump into a task
   * across projects. The param is consumed once: after seeding state, the
   * effect below strips it from the URL so navigating back to the project
   * doesn't reselect a stale task. Empty-string values from a malformed
   * `?task=` are coalesced to `null` so we never select an empty id.
   */
  const taskParam = searchParams.get("task") || null;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    taskParam,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navigatorClosed, setNavigatorClosed] = useState(false);
  /**
   * Controls the right-hand property rail inside the graph-mode detail
   * overlay. Persists across task changes so the user stays in their chosen
   * "compact" layout once they close it; resets to `true` when the
   * selection clears (matches drawerOpen / navigatorClosed reset semantics).
   */
  const [propRailOpen, setPropRailOpen] = useState(true);
  /**
   * Marks the auto-fallback view-switch as a low-priority transition. React
   * keeps the current (graph) view interactive while the new (structure)
   * tree renders in the background — without this, the synchronous
   * reconciliation freezes input for the duration of the swap.
   */
  const [, startViewTransition] = useTransition();

  /**
   * Slim row for the selected task. `null` while there is no selection AND
   * when the slim graph no longer contains the selected id (deleted by us
   * or by another tab via SSE).
   */
  const selectedTaskSlim: TaskGraphSlim | null =
    selectedTaskId && graph
      ? (graph.tasks.find((t) => t.id === selectedTaskId) ?? null)
      : null;

  /**
   * Render-phase reset: when the slim graph has refreshed and the selected
   * task is no longer in it (delete from another tab, undo created a new
   * id, etc.), drop the dangling selection so the body `useQuery` doesn't
   * keep polling a 404. Mirrors the existing `prevSelectedTaskId` reset
   * pattern below — keeps the reset inside the render cycle.
   */
  if (selectedTaskId && graph && !selectedTaskSlim) {
    setSelectedTaskId(null);
  }

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: projectKeys.graph(projectId) });
    if (selectedTaskId) {
      qc.invalidateQueries({
        queryKey: taskKeys.detail(projectId, selectedTaskId),
      });
    }
  }, [qc, projectId, selectedTaskId]);

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const nextQs = next.toString();
      if (nextQs === searchParams.toString()) return;
      router.replace(nextQs ? `${pathname}?${nextQs}` : pathname, {
        scroll: false,
      });
    },
    [router, pathname, searchParams],
  );

  /**
   * Watch the `?task=<id>` deep-link param. The `useState` initial-value
   * read above handles cross-project mounts (different `projectId`
   * remounts this client). For same-project jumps from the global
   * command palette, Next.js performs a soft re-render that keeps this
   * client mounted, so the initial value never re-fires; the
   * render-phase reset below promotes the param into `selectedTaskId`
   * (mirrors the `prevSelectedTaskId` pattern further down), and the
   * effect strips the param afterwards so back-navigation does not
   * reselect a stale task.
   */
  const [prevTaskParam, setPrevTaskParam] = useState<string | null>(taskParam);
  if (taskParam !== prevTaskParam) {
    setPrevTaskParam(taskParam);
    if (taskParam) {
      setSelectedTaskId(taskParam);
    }
  }
  useEffect(() => {
    if (taskParam) updateParam("task", null);
  }, [taskParam, updateParam]);

  /**
   * Select a task. At narrow viewports (`!isXl`), the graph canvas and
   * detail panel cannot share screen space, so auto-switch back to the
   * structure view when graph mode is currently active.
   *
   * @param taskId - Task to select.
   */
  const handleSelectNode = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      if (view === "graph" && !isXl) {
        // Wrap the URL change in a transition so React doesn't block the
        // input thread while the structure tree mounts. The cross-fade in
        // `WorkspaceLayout` masks any residual reconciliation cost.
        startViewTransition(() => updateParam("view", null));
      }
    },
    [view, isXl, updateParam],
  );

  const handleClose = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleSwitchToStructure = useCallback(() => {
    updateParam("view", null);
  }, [updateParam]);

  const [prevSelectedTaskId, setPrevSelectedTaskId] = useState<string | null>(
    null,
  );
  if (selectedTaskId !== prevSelectedTaskId) {
    setPrevSelectedTaskId(selectedTaskId);
    if (selectedTaskId === null) {
      setDrawerOpen(false);
      setNavigatorClosed(false);
      setPropRailOpen(true);
    }
  }

  const taskMap = useMemo(() => {
    if (!graph)
      return new Map<
        string,
        { title: string; status: string; taskRef: string }
      >();
    const map = new Map<
      string,
      { title: string; status: string; taskRef: string }
    >();
    for (const t of graph.tasks) {
      map.set(t.id, { title: t.title, status: t.status, taskRef: t.taskRef });
    }
    return map;
  }, [graph]);

  const projectTags = useMemo(() => {
    if (!graph) return [] as string[];
    const set = new Set<string>();
    for (const t of graph.tasks) for (const tag of t.tags ?? []) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [graph]);

  if (!graph) {
    return (
      <div className="flex h-[calc(var(--viewport-height)-var(--topbar-h))] items-center justify-center">
        <DeferredLoadingSpinner />
      </div>
    );
  }

  const showNavigatorToggle =
    view === "structure" && isXl && Boolean(selectedTaskSlim);

  const sharedLayoutProps: SharedLayoutProps = {
    projectId,
    graph,
    view,
    isXl,
    selectedTaskId,
    drawerOpen,
    setDrawerOpen,
    navigatorClosed,
    setNavigatorClosed,
    showNavigatorToggle,
    propRailOpen,
    setPropRailOpen,
    handleSelectNode,
    handleClose,
    handleSwitchToStructure,
    refreshAll,
    taskMap,
    projectTags,
  };

  if (selectedTaskSlim) {
    return (
      <WorkspaceBodyWithSelection
        {...sharedLayoutProps}
        taskSlim={selectedTaskSlim}
      />
    );
  }

  return (
    <WorkspaceLayout
      {...sharedLayoutProps}
      taskSlim={null}
      detail={<EmptyDetail />}
      propRail={null}
    />
  );
}

interface SharedLayoutProps {
  projectId: string;
  graph: ProjectGraphSlim;
  view: WorkspaceView;
  isXl: boolean;
  selectedTaskId: string | null;
  drawerOpen: boolean;
  setDrawerOpen: (updater: (v: boolean) => boolean) => void;
  navigatorClosed: boolean;
  setNavigatorClosed: (updater: (v: boolean) => boolean) => void;
  showNavigatorToggle: boolean;
  /** Whether the property rail is visible inside the graph-mode overlay. */
  propRailOpen: boolean;
  /** Functional setter — flips the propRailOpen state. */
  setPropRailOpen: (updater: (v: boolean) => boolean) => void;
  handleSelectNode: (taskId: string) => void;
  handleClose: () => void;
  handleSwitchToStructure: () => void;
  refreshAll: () => void;
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  projectTags: string[];
}

interface WorkspaceBodyWithSelectionProps extends SharedLayoutProps {
  /** Slim row for the currently selected task (already validated against the graph). */
  taskSlim: TaskGraphSlim;
}

/**
 * Renders the workspace layout for a live, in-graph selection. The
 * selected-task body is fetched here so the Query observer is only
 * registered when there is a non-null, valid task id — solves the cache
 * pollution issue where a placeholder query keyed on `""` would otherwise
 * survive every empty-state render.
 *
 * @param props - Layout + selected slim row.
 * @returns Layout with populated detail and prop rail slots.
 */
function WorkspaceBodyWithSelection(props: WorkspaceBodyWithSelectionProps) {
  const {
    projectId,
    graph,
    view,
    isXl,
    taskSlim,
    taskMap,
    projectTags,
    refreshAll,
    handleSelectNode,
    handleClose,
    drawerOpen,
    setDrawerOpen,
    navigatorClosed,
    setNavigatorClosed,
    showNavigatorToggle,
    propRailOpen,
    setPropRailOpen,
  } = props;
  // The property-rail toggle is only meaningful inside the graph overlay
  // (xl + graph view + selection). In structure mode the rail sits beside
  // the detail column with no overlay to shrink, so the toggle is hidden.
  const showPropRailToggle = view === "graph" && isXl;
  const qc = useQueryClient();
  const taskId = taskSlim.id;

  const { data: selectedTaskFull, isPlaceholderData } = useQuery({
    queryKey: taskKeys.detail(projectId, taskId),
    queryFn: fetchTaskBody(qc, projectId, taskId),
    placeholderData: (): TaskFullWithEdges | undefined => {
      const cached = qc.getQueryData<ProjectGraphSlim>(
        projectKeys.graph(projectId),
      );
      const slim = cached?.tasks.find((t) => t.id === taskId);
      if (!slim) return undefined;
      // Fields the slim projection lacks (description, sequenceNumber,
      // createdAt, files, assignees, ...) are fabricated empties below.
      // Anything that renders or mutates them must stay gated on
      // `isPlaceholderData` until the real detail fetch resolves.
      return {
        id: slim.id,
        projectId,
        title: slim.title,
        sequenceNumber: 0,
        description: "",
        status: slim.status,
        order: slim.order,
        category: slim.category ?? null,
        implementationPlan: null,
        executionRecord: null,
        tags: slim.tags ?? [],
        priority: slim.priority ?? null,
        estimate: slim.estimate ?? null,
        files: [],
        history: [],
        createdAt: new Date(),
        updatedAt: slim.updatedAt,
        taskRef: slim.taskRef,
        assignees: [],
        acceptanceCriteria: [],
        decisions: [],
        links: [],
        edges: [],
      };
    },
  });

  const taskFullMatches = selectedTaskFull && selectedTaskFull.id === taskId;
  const taskEdges: TaskEdgeRef[] =
    taskFullMatches && selectedTaskFull && !isPlaceholderData
      ? selectedTaskFull.edges
      : graph.edges
          .filter((e) => e.sourceTaskId === taskId || e.targetTaskId === taskId)
          .map((e) => ({ ...e, note: "" }));

  const detail =
    taskFullMatches && selectedTaskFull ? (
      <DetailPanel
        taskId={taskId}
        projectId={projectId}
        task={selectedTaskFull}
        parentName={graph.project.title}
        edges={taskEdges}
        allEdges={graph.edges}
        allTasks={graph.tasks}
        taskMap={taskMap}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onClose={handleClose}
        onSelectNode={handleSelectNode}
        onGraphChange={refreshAll}
        navigatorClosed={showNavigatorToggle ? navigatorClosed : undefined}
        onToggleNavigator={
          showNavigatorToggle ? () => setNavigatorClosed((v) => !v) : undefined
        }
        propRailOpen={showPropRailToggle ? propRailOpen : undefined}
        onTogglePropRail={
          showPropRailToggle ? () => setPropRailOpen((v) => !v) : undefined
        }
        isBodyLoading={isPlaceholderData}
      />
    ) : (
      <DetailLoading />
    );

  const propRail =
    taskFullMatches && selectedTaskFull ? (
      <PropRail
        taskId={taskId}
        projectId={projectId}
        status={selectedTaskFull.status}
        priority={selectedTaskFull.priority}
        estimate={selectedTaskFull.estimate}
        assignees={selectedTaskFull.assignees ?? []}
        organizationId={graph.project.organizationId}
        category={selectedTaskFull.category}
        categories={graph.project.categories}
        tags={selectedTaskFull.tags ?? []}
        projectTags={projectTags}
        edges={taskEdges}
        taskMap={taskMap}
        files={Array.from(new Set(selectedTaskFull.files ?? []))}
        projectIdentifier={graph.project.identifier}
        projectName={graph.project.title}
        onSelectNode={handleSelectNode}
        onGraphChange={refreshAll}
        isBodyLoading={isPlaceholderData}
      />
    ) : null;

  return (
    <WorkspaceLayout
      {...props}
      taskSlim={taskSlim}
      detail={detail}
      propRail={propRail}
    />
  );
}

interface WorkspaceLayoutProps extends SharedLayoutProps {
  taskSlim: TaskGraphSlim | null;
  detail: React.ReactNode;
  propRail: React.ReactNode;
}

/**
 * Pure layout shell. Receives pre-built `detail` and `propRail` JSX so the
 * useQuery for the task body lives outside this component. Branches on
 * `view`, `isXl`, and presence of `taskSlim` to drive the three layout
 * shapes (graph overlay, xl 3-column, narrow drawer).
 *
 * @param props - Layout shape configuration plus pre-built slot JSX.
 * @returns The right layout for the current breakpoint and view.
 */
function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const {
    projectId,
    graph,
    view,
    isXl,
    selectedTaskId,
    drawerOpen,
    setDrawerOpen,
    navigatorClosed,
    handleSelectNode,
    handleClose,
    handleSwitchToStructure,
    refreshAll,
    taskSlim,
    detail,
    propRail,
    propRailOpen,
  } = props;

  const navigator = (
    <NavigatorPanel
      tasks={graph.tasks}
      edges={graph.edges}
      categories={graph.project.categories}
      projectId={projectId}
      organizationId={graph.project.organizationId}
      selectedNodeId={selectedTaskId}
      onSelectNode={handleSelectNode}
      onGraphChange={refreshAll}
    />
  );

  // Layout-shape key. Every transition between these shapes (graph ↔ xl-
  // structure ↔ narrow-structure) unmounts a heavy subtree and mounts another
  // — synchronous reconciliation that, without animation, reads as a "jump"
  // and a brief input freeze. Keying an `AnimatePresence` on this value with
  // `mode="wait"` defers the new tree until the old one has faded out, so the
  // mount cost is hidden inside the opacity-0 phase of the transition.
  const layoutShape: "graph" | "xl" | "narrow" =
    view === "graph" ? "graph" : isXl ? "xl" : "narrow";

  let layoutBody: React.ReactNode;
  if (layoutShape === "graph") {
    const showOverlay = isXl && Boolean(taskSlim);
    layoutBody = (
      <div className="flex h-[calc(var(--viewport-height)-var(--topbar-h))]">
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceGraphView
            projectId={projectId}
            tasks={graph.tasks}
            edges={graph.edges}
            selectedNodeId={selectedTaskId}
            onSelectNode={handleSelectNode}
            onDeselect={handleClose}
            onSwitchToStructure={handleSwitchToStructure}
            detailSlot={showOverlay ? detail : undefined}
            propRailSlot={showOverlay ? propRail : undefined}
            propRailOpen={propRailOpen}
          />
        </div>
      </div>
    );
  } else if (layoutShape === "xl") {
    layoutBody = (
      <div className="flex h-[calc(var(--viewport-height)-var(--topbar-h))]">
        <motion.div
          className="flex flex-col overflow-hidden"
          animate={{ width: navigatorClosed ? 0 : 460 }}
          initial={false}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          style={{ flexShrink: 0, minWidth: 0 }}
        >
          <div className="flex h-full min-w-[320px] flex-col">{navigator}</div>
        </motion.div>
        <motion.div
          aria-hidden="true"
          className="bg-gradient-to-b from-border-strong via-border to-transparent"
          animate={{
            width: navigatorClosed ? 0 : 1,
            opacity: navigatorClosed ? 0 : 1,
          }}
          initial={false}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          style={{ flexShrink: 0 }}
        />
        <div data-panel="detail" className="flex min-w-0 flex-1 flex-col">
          {detail}
        </div>
        {propRail}
      </div>
    );
  } else {
    layoutBody = (
      <>
        <TwoPanelLayout
          activePanelHint={selectedTaskId ? "right" : "left"}
          left={navigator}
          right={detail}
        />
        <PropRailDrawer
          open={drawerOpen && !!taskSlim}
          onClose={() => setDrawerOpen(() => false)}
        >
          {propRail}
        </PropRailDrawer>
      </>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={layoutShape}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="h-full"
      >
        {layoutBody}
      </motion.div>
    </AnimatePresence>
  );
}

/** Placeholder shown when no task is selected. */
function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-sm text-text-secondary">No task selected</p>
      <p className="mt-1 max-w-sm text-xs text-text-muted">
        Pick a task from the navigator to view and edit its details.
      </p>
    </div>
  );
}

/** Loading state while a freshly-selected task body is being fetched. */
function DetailLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <DeferredLoadingSpinner />
    </div>
  );
}
