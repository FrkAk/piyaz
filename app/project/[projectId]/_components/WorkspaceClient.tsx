"use client";

import { useCallback, useMemo, useState } from "react";
import { motion } from "motion/react";
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
 * sync; reads the slim graph and the selected task body via TanStack Query
 * (server prefetches the slim graph; SSE invalidates on remote mutations).
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

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navigatorClosed, setNavigatorClosed] = useState(false);

  const { data: selectedTaskFull } = useQuery({
    queryKey: taskKeys.detail(projectId, selectedTaskId ?? ""),
    queryFn: fetchTaskBody(qc, projectId, selectedTaskId ?? ""),
    enabled: !!selectedTaskId,
  });

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
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const handleSelectNode = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      // At narrow viewports there is no room to show the canvas + detail at
      // once. Auto-switch back to structure so the user lands on the task.
      if (view === "graph" && !isXl) updateParam("view", null);
    },
    [view, isXl, updateParam],
  );

  const handleClose = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleSwitchToStructure = useCallback(() => {
    updateParam("view", null);
  }, [updateParam]);

  // Render-phase reset: when selection clears, also collapse the detail-
  // adjacent UI state. Mirrors the old workspace's `prevSelectedTaskId`
  // pattern so the reset stays in the render cycle (no effect needed).
  const [prevSelectedTaskId, setPrevSelectedTaskId] = useState<string | null>(
    null,
  );
  if (selectedTaskId !== prevSelectedTaskId) {
    setPrevSelectedTaskId(selectedTaskId);
    if (selectedTaskId === null) {
      setDrawerOpen(false);
      setNavigatorClosed(false);
    }
  }

  const taskMap = useMemo(() => {
    if (!graph) return new Map<string, { title: string; status: string; taskRef: string }>();
    const map = new Map<string, { title: string; status: string; taskRef: string }>();
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

  const selectedTaskSlim = selectedTaskId
    ? graph.tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  const taskEdges = selectedTaskId
    ? graph.edges.filter(
        (e) => e.sourceTaskId === selectedTaskId || e.targetTaskId === selectedTaskId,
      )
    : [];

  const navigator = (
    <NavigatorPanel
      tasks={graph.tasks}
      edges={graph.edges}
      categories={graph.project.categories}
      projectId={projectId}
      selectedNodeId={selectedTaskId}
      onSelectNode={handleSelectNode}
      onGraphChange={refreshAll}
    />
  );

  const showNavigatorToggle =
    view === "structure" && isXl && Boolean(selectedTaskSlim);

  const taskFullMatches =
    selectedTaskFull && selectedTaskFull.id === selectedTaskId;

  const detail = selectedTaskSlim ? (
    taskFullMatches && selectedTaskFull ? (
      <DetailPanel
        taskId={selectedTaskId!}
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
      />
    ) : (
      <DetailLoading />
    )
  ) : (
    <EmptyDetail />
  );

  const propRail =
    selectedTaskSlim && taskFullMatches && selectedTaskFull ? (
      <PropRail
        taskId={selectedTaskId!}
        status={selectedTaskFull.status}
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
      />
    ) : null;

  if (view === "graph") {
    const showOverlay = isXl && Boolean(selectedTaskSlim);
    return (
      <div className="flex h-[calc(var(--viewport-height)-var(--topbar-h))]">
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceGraphView
            tasks={graph.tasks}
            edges={graph.edges}
            selectedNodeId={selectedTaskId}
            onSelectNode={handleSelectNode}
            onDeselect={handleClose}
            onSwitchToStructure={handleSwitchToStructure}
            detailSlot={showOverlay ? detail : undefined}
            propRailSlot={showOverlay ? propRail : undefined}
          />
        </div>
      </div>
    );
  }

  if (isXl) {
    return (
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
          animate={{ width: navigatorClosed ? 0 : 1, opacity: navigatorClosed ? 0 : 1 }}
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
  }

  return (
    <>
      <TwoPanelLayout
        activePanelHint={selectedTaskId ? "right" : "left"}
        left={navigator}
        right={detail}
      />
      <PropRailDrawer
        open={drawerOpen && !!selectedTaskSlim}
        onClose={() => setDrawerOpen(false)}
      >
        {propRail}
      </PropRailDrawer>
    </>
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
