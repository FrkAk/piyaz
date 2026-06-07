"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  FilterBar,
  type GroupKey,
  type SortKey,
  type WorkspaceView,
} from "./structure/FilterBar";
import { StructureView } from "./structure/StructureView";
import type { TaskGraphEdge, TaskGraphSlim } from "@/lib/data/views";

interface NavigatorPanelProps {
  /** All project tasks (slim, augmented with composed `taskRef`). */
  tasks: TaskGraphSlim[];
  /** All project edges in slim graph shape. */
  edges: TaskGraphEdge[];
  /** Project-level categories. */
  categories: string[];
  /** Project UUID. */
  projectId: string;
  /** Organization UUID — passed through to StructureView for team-member avatars. */
  organizationId: string;
  /** Currently selected task ID. */
  selectedNodeId: string | null;
  /** Click a task to open the detail. */
  onSelectNode: (taskId: string) => void;
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Read the current URL search params and count active filters — used to
 * badge the filter button in the header bar.
 *
 * @param searchParams - Live `URLSearchParams` from `useSearchParams`.
 * @returns Cumulative count across all filter keys.
 */
function readFilterCount(searchParams: URLSearchParams): number {
  let count = 0;
  for (const key of ["tags", "cat", "status", "pri"] as const) {
    const value = searchParams.get(key);
    if (value) count += value.split(",").filter(Boolean).length;
  }
  if (searchParams.get("q")?.trim()) count += 1;
  return count;
}

/**
 * Resolve the active view from the URL — defaults to `structure` when the
 * key is missing or unrecognised.
 *
 * @param raw - Raw `view` query param.
 * @returns Workspace view identifier.
 */
function readView(raw: string | null): WorkspaceView {
  if (raw === "graph") return "graph";
  return "structure";
}

/**
 * Read the active sort key from the URL — defaults to `status`.
 *
 * @param raw - Raw `sort` query param.
 * @returns Sort key.
 */
function readSort(raw: string | null): SortKey {
  if (raw === "updated" || raw === "identifier" || raw === "priority")
    return raw;
  return "status";
}

/**
 * Read the active group key from the URL — defaults to `status` so the
 * default Linear-style status grouping survives a refresh.
 *
 * @param raw - Raw `group` query param.
 * @returns Group key.
 */
function readGroup(raw: string | null): GroupKey {
  if (raw === "category" || raw === "none") return raw;
  return "status";
}

/**
 * Workspace navigator — top-aligned filter bar with view tabs, then the
 * active view body. Persists view + sort to the URL so the workspace is
 * shareable; filter chips and the search query live in the URL too via
 * StructureView's own sync.
 *
 * @param props - Navigator panel configuration.
 * @returns Navigator panel element.
 */
export function NavigatorPanel({
  tasks,
  edges,
  categories,
  projectId,
  organizationId,
  selectedNodeId,
  onSelectNode,
  onGraphChange,
  className = "",
}: NavigatorPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const view = readView(searchParams.get("view"));
  const sort = readSort(searchParams.get("sort"));
  const group = readGroup(searchParams.get("group"));
  const filterCount = useMemo(
    () => readFilterCount(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const [filterOpen, setFilterOpen] = useState(false);

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const nextQs = next.toString();
      const currentQs = searchParams.toString();
      // Skip when nothing changed — e.g. clicking the already-active option.
      // Each `router.replace` triggers an RSC refetch of the project layout,
      // so eliding no-op replaces avoids unnecessary server work.
      if (nextQs === currentQs) return;
      router.replace(nextQs ? `${pathname}?${nextQs}` : pathname, {
        scroll: false,
      });
    },
    [router, pathname, searchParams],
  );

  const handleViewChange = useCallback(
    (next: WorkspaceView) => {
      updateParam("view", next === "structure" ? null : next);
      if (next !== "structure") setFilterOpen(false);
    },
    [updateParam],
  );

  const handleSortChange = useCallback(
    (next: SortKey) => {
      updateParam("sort", next === "status" ? null : next);
    },
    [updateParam],
  );

  const handleGroupChange = useCallback(
    (next: GroupKey) => {
      updateParam("group", next === "status" ? null : next);
    },
    [updateParam],
  );

  return (
    <div className={`flex h-full flex-col ${className}`} data-panel="navigator">
      <FilterBar
        view={view}
        onViewChange={handleViewChange}
        sort={sort}
        onSortChange={handleSortChange}
        group={group}
        onGroupChange={handleGroupChange}
        filterOpen={filterOpen}
        filterCount={filterCount}
        onToggleFilter={() => setFilterOpen((v) => !v)}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <StructureView
          tasks={tasks}
          edges={edges}
          projectId={projectId}
          organizationId={organizationId}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onGraphChange={onGraphChange}
          filterOpen={filterOpen}
          sort={sort}
          group={group}
          categories={categories}
        />
      </div>
    </div>
  );
}

export default NavigatorPanel;
