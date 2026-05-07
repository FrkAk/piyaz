'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TwoPanelLayout } from '@/components/layout/TwoPanelLayout';
import { NavigatorPanel } from '@/components/workspace/NavigatorPanel';
import { DetailPanel } from '@/components/workspace/DetailPanel';
import { PropRail } from '@/components/workspace/detail/PropRail';
import { PropRailDrawer } from '@/components/workspace/detail/PropRailDrawer';
import { WorkspaceGraphView } from '@/components/workspace/graph/WorkspaceGraphView';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import type { ProjectGraphSlim, TaskFull } from '@/lib/data/views';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { dedupedFetch } from '@/lib/fetch-dedupe';

/** Workspace view identifier — mirrors the navigator's FilterBar value. */
type WorkspaceView = 'structure' | 'graph';

/**
 * Compute the latest updatedAt across project, tasks, and edges so we can
 * skip a re-render when the SSE refresh produces no actual change.
 *
 * @param graph - The slim project graph.
 * @returns ISO timestamp string of the most recent update.
 */
function getMaxUpdatedAt(graph: ProjectGraphSlim): string {
  let max = String(graph.project.updatedAt ?? '');
  for (const t of graph.tasks) if (String(t.updatedAt) > max) max = String(t.updatedAt);
  for (const e of graph.edges) if (String(e.updatedAt) > max) max = String(e.updatedAt);
  return max;
}

/**
 * Type guard narrowing a DOM Event to a `mymir:project-updated` CustomEvent.
 *
 * @param e - Incoming DOM event.
 * @returns True when `e` carries the expected `{ projectId?: string }` shape.
 */
function isProjectUpdatedEvent(e: Event): e is CustomEvent<{ projectId?: string }> {
  if (!(e instanceof CustomEvent)) return false;
  const detail: unknown = e.detail;
  if (detail === null || detail === undefined) return true;
  if (typeof detail !== 'object') return false;
  const maybe = detail as { projectId?: unknown };
  return maybe.projectId === undefined || typeof maybe.projectId === 'string';
}

/**
 * Resolve the active view from the URL — defaults to `structure`. Mirrors
 * the navigator's own `readView` so the page-level branch and the FilterBar
 * never disagree about which surface is active.
 *
 * @param raw - Raw `view` query param.
 * @returns Workspace view identifier.
 */
function readView(raw: string | null): WorkspaceView {
  return raw === 'graph' ? 'graph' : 'structure';
}

/**
 * Fetch the slim project graph via the deduped fetch cache.
 *
 * @param projectId - Project UUID.
 * @returns Parsed slim graph or null on failure.
 */
async function fetchProjectGraph(projectId: string): Promise<ProjectGraphSlim | null> {
  return dedupedFetch<ProjectGraphSlim | null>(`graph:${projectId}`, () =>
    fetch(`/api/project/${projectId}/graph`).then((r) => (r.ok ? r.json() : null)),
  );
}

/**
 * Workspace page — three-column layout above 1280px (navigator | detail |
 * property rail), two columns + drawer below 1280px, mobile toggle below
 * 1024px. In graph mode the navigator slot is replaced with the
 * `WorkspaceGraphView` (rail + canvas); detail and property rail behave
 * identically once a task is selected so operators get the same task
 * workspace either way.
 *
 * The slim project graph powers the canvas/list. The selected task's
 * heavy fields (description, plan, criteria, decisions, executionRecord,
 * files, history) come from a per-task lazy fetch so the recurring graph
 * refresh stays small.
 *
 * @returns Client-rendered workspace page.
 */
export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = readView(searchParams.get('view'));

  const [graph, setGraph] = useState<ProjectGraphSlim | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskFull, setSelectedTaskFull] = useState<TaskFull | null>(null);
  const [taskContext, setTaskContext] = useState<{ agent: string; planning: string; working: string }>({ agent: '', planning: '', working: '' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navigatorClosed, setNavigatorClosed] = useState(false);
  const lastModifiedRef = useRef('');
  const isXl = useMediaQuery('(min-width: 1280px)', true);

  const refreshGraph = useCallback(async () => {
    const data = await fetchProjectGraph(projectId);
    if (!data) return;
    const maxUpdated = getMaxUpdatedAt(data);
    if (maxUpdated !== lastModifiedRef.current) {
      lastModifiedRef.current = maxUpdated;
      setGraph(data);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    fetchProjectGraph(projectId).then((data) => {
      if (cancelled || !data) return;
      const maxUpdated = getMaxUpdatedAt(data);
      if (maxUpdated !== lastModifiedRef.current) {
        lastModifiedRef.current = maxUpdated;
        setGraph(data);
      }
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // Fetch the selected task's full body (description, plan, criteria,
  // decisions, executionRecord, files, history) on selection. The slim
  // graph deliberately omits these so the recurring refresh stays small.
  // The previous body is cleared in the render-phase reset block below
  // so the cleared state is visible to the loader before the fetch lands.
  useEffect(() => {
    if (!selectedTaskId) return;
    let cancelled = false;
    fetch(`/api/task/${selectedTaskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TaskFull | null) => {
        if (!cancelled && data) setSelectedTaskFull(data);
      })
      .catch((err) => { if (!cancelled) console.error('[workspace] task fetch failed:', err); });
    return () => { cancelled = true; };
  }, [selectedTaskId]);

  const refreshSelectedTask = useCallback(async () => {
    if (!selectedTaskId) return;
    const data = await fetch(`/api/task/${selectedTaskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (data) setSelectedTaskFull(data);
  }, [selectedTaskId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshGraph(), refreshSelectedTask()]);
  }, [refreshGraph, refreshSelectedTask]);

  useRefreshOnFocus(refreshAll, `/api/project/${projectId}/events`);

  useEffect(() => {
    const handler = (e: Event): void => {
      if (!isProjectUpdatedEvent(e)) return;
      const detail = e.detail;
      if (!detail?.projectId || detail.projectId === projectId) {
        lastModifiedRef.current = '';
        refreshAll();
      }
    };
    window.addEventListener('mymir:project-updated', handler);
    return () => window.removeEventListener('mymir:project-updated', handler);
  }, [projectId, refreshAll]);

  const [prevSelectedTaskId, setPrevSelectedTaskId] = useState<string | null>(null);
  if (selectedTaskId !== prevSelectedTaskId) {
    setPrevSelectedTaskId(selectedTaskId);
    // Clear the previous task body so the detail column shows the loading
    // state until the new task's lazy fetch resolves.
    setSelectedTaskFull(null);
    if (!selectedTaskId) {
      setTaskContext({ agent: '', planning: '', working: '' });
      setDrawerOpen(false);
      // Closing a task auto-restores the navigator. The toggle is only useful
      // *while* a task is selected, so resetting it on deselect keeps the
      // shell predictable on the next open.
      setNavigatorClosed(false);
    }
  }

  useEffect(() => {
    if (!selectedTaskId) return;

    let cancelled = false;
    dedupedFetch(`context:${projectId}:${selectedTaskId}`, () =>
      fetch(`/api/project/${projectId}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: selectedTaskId }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Context fetch failed: ${r.status}`);
        return r.json() as Promise<{ agent: string; planning: string; working: string }>;
      }),
    )
      .then((data) => {
        if (!cancelled) setTaskContext({
          agent: data.agent ?? '',
          planning: data.planning ?? '',
          working: data.working ?? '',
        });
      })
      .catch((err) => { if (!cancelled) console.error('[workspace] context fetch failed:', err); });
    return () => { cancelled = true; };
  }, [projectId, selectedTaskId]);

  /**
   * Update a single search-param key without disturbing the rest. Mirrors the
   * navigator's helper so the URL contract stays consistent across surfaces.
   *
   * @param key - Param key to update.
   * @param value - New value (or `null` to delete).
   */
  const updateParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  const handleSelectNode = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      // At narrow viewports there is no room to show the canvas + detail at
      // once. Auto-switch back to structure so the user lands on the task.
      if (view === 'graph' && !isXl) {
        updateParam('view', null);
      }
    },
    [view, isXl, updateParam],
  );

  const handleClose = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleSwitchToStructure = useCallback(() => {
    updateParam('view', null);
  }, [updateParam]);

  const taskMap = useMemo(() => {
    if (!graph) return new Map<string, { title: string; status: string; taskRef: string }>();
    const map = new Map<string, { title: string; status: string; taskRef: string }>();
    for (const t of graph.tasks) map.set(t.id, { title: t.title, status: t.status, taskRef: t.taskRef });
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
        <LoadingSpinner />
      </div>
    );
  }

  const selectedTaskSlim = selectedTaskId
    ? graph.tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  const taskEdges = selectedTaskId
    ? graph.edges.filter((e) => e.sourceTaskId === selectedTaskId || e.targetTaskId === selectedTaskId)
    : [];

  const navigator = (
    <NavigatorPanel
      tasks={graph.tasks}
      edges={graph.edges}
      categories={graph.project.categories}
      projectId={projectId}
      selectedNodeId={selectedTaskId}
      onSelectNode={handleSelectNode}
      onGraphChange={refreshGraph}
    />
  );

  const showNavigatorToggle = view === 'structure' && isXl && Boolean(selectedTaskSlim);
  const detail = selectedTaskSlim ? (
    selectedTaskFull && selectedTaskFull.id === selectedTaskId ? (
      <DetailPanel
        taskId={selectedTaskId!}
        projectId={projectId}
        task={selectedTaskFull}
        parentName={graph.project.title}
        edges={taskEdges}
        allEdges={graph.edges}
        allTasks={graph.tasks}
        bundles={taskContext}
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

  const propRail = selectedTaskSlim && selectedTaskFull && selectedTaskFull.id === selectedTaskId ? (
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

  // Graph view — canvas always fills the available width. When a task is
  // selected at xl, detail + property rail slide in as a right-pinned overlay
  // on top of the canvas (no layout reflow). Below xl `handleSelectNode`
  // already routes the click through structure mode, so the overlay is xl-only.
  if (view === 'graph') {
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

  // Structure view — when a task is selected at xl, the navigator column can
  // be folded away via the detail header's panel-toggle so the operator
  // focuses on the task. Width animates with motion; closing the task (Esc /
  // close button) auto-resets the toggle so the next open still sees the list.
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
        activePanelHint={selectedTaskId ? 'right' : 'left'}
        left={navigator}
        right={detail}
      />
      <PropRailDrawer open={drawerOpen && !!selectedTaskSlim} onClose={() => setDrawerOpen(false)}>
        {propRail}
      </PropRailDrawer>
    </>
  );
}

/**
 * Empty placeholder for when no task is selected — same copy as the
 * previous workspace shell so the muscle memory carries over.
 *
 * @returns Centred hint card.
 */
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

/**
 * Loading placeholder shown while the per-task body is fetched after
 * selecting a task. Keeps the column reserved so the layout doesn't jump.
 *
 * @returns Centred spinner.
 */
function DetailLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingSpinner />
    </div>
  );
}
