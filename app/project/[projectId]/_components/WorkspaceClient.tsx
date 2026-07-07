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
import type { DeletedTask } from "@/components/workspace/structure/StructureView";
import { DetailPanel } from "@/components/workspace/DetailPanel";
import { PropRail } from "@/components/workspace/detail/PropRail";
import { PropRailDrawer } from "@/components/workspace/detail/PropRailDrawer";
import { WorkspaceGraphView } from "@/components/workspace/graph/WorkspaceGraphView";
import { NotesView } from "@/components/workspace/notes/NotesView";
import {
  readView,
  type WorkspaceView,
} from "@/components/workspace/ViewSwitcher";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSkeletonVisibility } from "@/hooks/useSkeletonVisibility";
import { useUndo } from "@/hooks/useUndo";
import { createTask } from "@/lib/graph/mutations";
import { DeferredLoadingSpinner } from "@/components/shared/DeferredLoadingSpinner";
import { projectKeys, taskKeys } from "@/lib/query/keys";
import { fetchProjectGraph, fetchTaskBody } from "@/lib/query/queries";
import type {
  ProjectGraphSlim,
  TaskEdgeRef,
  TaskFullWithEdges,
  TaskGraphSlim,
} from "@/lib/data/views";

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
 * @returns Three-column workspace, with graph mode swap when `?view=graph`
 *   and the notes surface when `?view=notes`.
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
  /**
   * Selected note sourced from the `?note=<id>` query param. Unlike
   * `?task`, the param is persistent selection state (like `?sort`), never
   * consumed and stripped — switching views keeps it, and returning to
   * Notes restores the selection. Empty-string values coalesce to `null`.
   */
  const noteId = searchParams.get("note") || null;
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
      qc.invalidateQueries({
        queryKey: taskKeys.activity(projectId, selectedTaskId),
      });
    }
  }, [qc, projectId, selectedTaskId]);

  const [undoError, setUndoError] = useState<string | null>(null);

  /**
   * Recreate a deleted task from its undo snapshot. Lives here (not in
   * StructureView) because the undo stack must survive the layout
   * subtree's remounts; a rejection sets `undoError` for the navigator's
   * undo strip and propagates to useUndo so the entry is re-pushed
   * instead of lost.
   *
   * @param item - Undo snapshot captured at delete time.
   */
  const handleRestoreTask = useCallback(
    async (item: DeletedTask) => {
      const t = item.taskData;
      setUndoError(null);
      try {
        await createTask({
          projectId: t.projectId,
          title: t.title,
          description: t.description,
          status: t.status,
          order: graph?.tasks.length ?? 0,
          acceptanceCriteria: t.acceptanceCriteria,
          decisions: t.decisions,
          implementationPlan: t.implementationPlan,
          executionRecord: t.executionRecord,
          tags: t.tags,
          category: t.category,
          files: t.files,
        });
      } catch (err) {
        setUndoError("Couldn't restore the task. Try again in a moment.");
        throw err;
      }
      refreshAll();
    },
    [graph, refreshAll],
  );

  // The delete-undo stack is owned here — NOT by StructureView — because
  // the layout subtree below remounts on view switches, breakpoint flips,
  // and (historically) selection transitions. The stack holds the only
  // copy of a deleted task's body, so any remount-scoped state wipe is
  // permanent data loss. WorkspaceClient only remounts on project change.
  const { canUndo, push, undo } = useUndo<DeletedTask>({
    onUndo: handleRestoreTask,
    keyboard: { panelSelector: '[data-panel="navigator"]' },
  });

  /**
   * Record a deleted task for restore, clearing any stale restore error.
   * @param item - Undo snapshot captured at delete time.
   */
  const pushUndo = useCallback(
    (item: DeletedTask) => {
      setUndoError(null);
      push(item);
    },
    [push],
  );

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

  /**
   * Select a task from an inline chip inside the notes editor. The notes
   * layout renders no task-detail slot, so opening the detail switches to
   * the structure view; the persistent `?note` param restores the Notes
   * selection on return.
   *
   * @param taskId - Task to select.
   */
  const handleSelectTaskFromNote = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      startViewTransition(() => updateParam("view", null));
    },
    [updateParam],
  );

  /**
   * Select a note (writes `?note=<id>`) or clear the selection with `null`.
   *
   * @param nextNoteId - Note to select, or null to clear.
   */
  const handleSelectNote = useCallback(
    (nextNoteId: string | null) => {
      updateParam("note", nextNoteId);
    },
    [updateParam],
  );

  /**
   * Open a note from a task's linked-notes card: switch to the Notes view
   * and select the note in one `router.replace`. Both params are written
   * together (not via two chained `updateParam` calls) because each
   * `updateParam` rebuilds the query string from the same stale
   * `searchParams` closure, so the second replace would drop the first.
   *
   * @param nextNoteId - Note to open on the Notes surface.
   */
  const handleOpenNoteFromTask = useCallback(
    (nextNoteId: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("view", "notes");
      next.set("note", nextNoteId);
      const nextQs = next.toString();
      startViewTransition(() => {
        router.replace(nextQs ? `${pathname}?${nextQs}` : pathname, {
          scroll: false,
        });
      });
    },
    [router, pathname, searchParams],
  );

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
    noteId,
    handleSelectNote,
    handleSelectTaskFromNote,
    handleOpenNoteFromTask,
    refreshAll,
    taskMap,
    projectTags,
    canUndo,
    undo,
    pushUndo,
    undoError,
  };

  // A single, unconditional <WorkspaceLayout> keeps the component type at
  // this tree position stable across selection transitions. The previous
  // shape (WorkspaceBodyWithSelection wrapping the layout only when a task
  // was selected) changed the element type whenever the selection flipped
  // between null and non-null, so React remounted the entire layout
  // subtree — wiping StructureView's filters, scroll position, and
  // (before the stack was lifted here) the delete-undo stack.
  return (
    <WorkspaceLayout
      {...sharedLayoutProps}
      taskSlim={selectedTaskSlim}
      detail={
        selectedTaskSlim ? (
          <WorkspaceDetailSlot
            {...sharedLayoutProps}
            taskSlim={selectedTaskSlim}
          />
        ) : (
          <EmptyDetail />
        )
      }
      propRail={
        selectedTaskSlim ? (
          <WorkspacePropRailSlot
            {...sharedLayoutProps}
            taskSlim={selectedTaskSlim}
          />
        ) : null
      }
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
  /** Selected note id from the `?note` query param, or null. */
  noteId: string | null;
  /** Select a note (writes `?note=<id>`) or clear with null. */
  handleSelectNote: (noteId: string | null) => void;
  /** Select a task from a notes-editor chip and switch to the structure view. */
  handleSelectTaskFromNote: (taskId: string) => void;
  /** Open a note from a task's linked-notes card: switch to Notes and select it. */
  handleOpenNoteFromTask: (noteId: string) => void;
  refreshAll: () => void;
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  projectTags: string[];
  /** Whether a deleted task is available to restore. */
  canUndo: boolean;
  /** Restore the most recently deleted task. */
  undo: () => void;
  /** Record a deleted task so it can be restored. */
  pushUndo: (item: DeletedTask) => void;
  /** Message shown in the undo strip when restoring a deleted task failed. */
  undoError: string | null;
}

interface SelectedTaskSlotProps extends SharedLayoutProps {
  /** Slim row for the currently selected task (already validated against the graph). */
  taskSlim: TaskGraphSlim;
}

/**
 * Fetch the selected task's full body for the detail / prop-rail slots.
 * The slots only mount while a live, in-graph selection exists, so the
 * Query observer is never registered for an empty selection — preserves
 * the invariant that no placeholder query keyed on `""` pollutes the
 * cache. Both slots share one cache entry; the second observer costs no
 * extra fetch.
 *
 * @param projectId - Project UUID.
 * @param taskId - Selected task UUID.
 * @param graph - Slim project graph (placeholder + edge fallback source).
 * @returns Body data, placeholder flag, identity match, and edge refs.
 */
function useSelectedTaskBody(
  projectId: string,
  taskId: string,
  graph: ProjectGraphSlim,
) {
  const qc = useQueryClient();

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

  const taskFullMatches = Boolean(
    selectedTaskFull && selectedTaskFull.id === taskId,
  );
  const taskEdges: TaskEdgeRef[] =
    taskFullMatches && selectedTaskFull && !isPlaceholderData
      ? selectedTaskFull.edges
      : graph.edges
          .filter((e) => e.sourceTaskId === taskId || e.targetTaskId === taskId)
          .map((e) => ({ ...e, note: "" }));

  return { selectedTaskFull, isPlaceholderData, taskFullMatches, taskEdges };
}

/**
 * Detail-panel slot for a live selection. A slot component (not a layout
 * wrapper) so `WorkspaceLayout`'s element type stays stable when the
 * selection flips between null and non-null — wrapping the layout in a
 * selection-only component remounted the whole subtree on every
 * selection transition.
 *
 * @param props - Layout props + selected slim row.
 * @returns DetailPanel, or a loading placeholder until the body matches.
 */
function WorkspaceDetailSlot(props: SelectedTaskSlotProps) {
  const {
    projectId,
    graph,
    view,
    isXl,
    taskSlim,
    taskMap,
    refreshAll,
    handleSelectNode,
    handleClose,
    handleOpenNoteFromTask,
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
  const taskId = taskSlim.id;
  const { selectedTaskFull, isPlaceholderData, taskFullMatches, taskEdges } =
    useSelectedTaskBody(projectId, taskId, graph);
  const showBodySkeleton = useSkeletonVisibility(isPlaceholderData, taskId);

  if (!taskFullMatches || !selectedTaskFull) return <DetailLoading />;
  return (
    <DetailPanel
      taskId={taskId}
      projectId={projectId}
      task={selectedTaskFull}
      parentName={graph.project.title}
      parentDescription={graph.project.description}
      edges={taskEdges}
      allEdges={graph.edges}
      allTasks={graph.tasks}
      taskMap={taskMap}
      projectIdentifier={graph.project.identifier}
      onOpenNote={handleOpenNoteFromTask}
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
      showBodySkeleton={showBodySkeleton}
    />
  );
}

/**
 * Prop-rail slot for a live selection. Shares the body query cache entry
 * with {@link WorkspaceDetailSlot}.
 *
 * @param props - Layout props + selected slim row.
 * @returns PropRail, or null until the body matches.
 */
function WorkspacePropRailSlot(props: SelectedTaskSlotProps) {
  const {
    projectId,
    graph,
    taskSlim,
    taskMap,
    projectTags,
    refreshAll,
    handleSelectNode,
  } = props;
  const taskId = taskSlim.id;
  const { selectedTaskFull, isPlaceholderData, taskFullMatches, taskEdges } =
    useSelectedTaskBody(projectId, taskId, graph);

  if (!taskFullMatches || !selectedTaskFull) return null;
  return (
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
 * `view`, `isXl`, and presence of `taskSlim` to drive the four layout
 * shapes (graph overlay, xl 3-column, narrow drawer, notes). The view
 * switcher lives in the global TopBar, not here.
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
    noteId,
    handleSelectNote,
    handleSelectTaskFromNote,
    refreshAll,
    taskSlim,
    detail,
    propRail,
    propRailOpen,
    canUndo,
    undo,
    pushUndo,
    undoError,
    taskMap,
    projectTags,
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
      canUndo={canUndo}
      onUndo={undo}
      pushUndo={pushUndo}
      undoError={undoError}
    />
  );

  // Layout-shape key. Every transition between these shapes (graph ↔ xl-
  // structure ↔ narrow-structure ↔ notes) unmounts a heavy subtree and mounts
  // another — synchronous reconciliation that, without animation, reads as a
  // "jump" and a brief input freeze. Keying an `AnimatePresence` on this value
  // with `mode="wait"` defers the new tree until the old one has faded out, so
  // the mount cost is hidden inside the opacity-0 phase of the transition.
  const layoutShape: "graph" | "xl" | "narrow" | "notes" =
    view === "graph"
      ? "graph"
      : view === "notes"
        ? "notes"
        : isXl
          ? "xl"
          : "narrow";

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
            detailSlot={showOverlay ? detail : undefined}
            propRailSlot={showOverlay ? propRail : undefined}
            propRailOpen={propRailOpen}
          />
        </div>
      </div>
    );
  } else if (layoutShape === "notes") {
    layoutBody = (
      <div className="flex h-[calc(var(--viewport-height)-var(--topbar-h))]">
        <NotesView
          projectId={projectId}
          projectIdentifier={graph.project.identifier}
          noteId={noteId}
          onSelectNote={handleSelectNote}
          onSelectTask={handleSelectTaskFromNote}
          taskMap={taskMap}
          categories={graph.project.categories}
          projectTags={projectTags}
        />
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
