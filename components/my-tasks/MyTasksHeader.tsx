"use client";

import type { TaskState } from "@/lib/data/task";
import { StatusCountToggles } from "./StatusCountToggles";

interface MyTasksHeaderProps {
  /** Total count rendered in the badge. */
  totalCount: number;
  /** Per-state counts derived from the active view. */
  viewCounts: Record<TaskState, number>;
  /** Active single-select status filter. */
  statusFilter: TaskState | null;
  /** Toggle the status filter. */
  onToggleStatus: (state: TaskState) => void;
  /** When true, the total badge renders dimmed (empty-state hint). */
  dimTotal?: boolean;
}

/**
 * Page header — `<h1>My tasks</h1>` plus the `[ N ASSIGNED ]` mono badge,
 * followed by the clickable status-count toggle row. The badge dims to
 * `opacity-55` when the user has zero tasks (empty state surface).
 *
 * @param props - Header configuration.
 * @returns Header block.
 */
export function MyTasksHeader({
  totalCount,
  viewCounts,
  statusFilter,
  onToggleStatus,
  dimTotal = false,
}: MyTasksHeaderProps) {
  return (
    <header className="mb-3 flex flex-col gap-3.5">
      <div className="flex items-center gap-3.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-primary">
          My tasks
        </h1>
        <span
          className={`inline-flex h-[20px] items-center gap-1 rounded-md border border-border-strong bg-surface-raised px-2 transition-opacity ${
            dimTotal ? "opacity-55" : ""
          }`}
        >
          <span className="font-mono text-[11px] font-semibold tabular-nums text-text-primary">
            {totalCount}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-muted">
            assigned
          </span>
        </span>
      </div>
      <StatusCountToggles
        viewCounts={viewCounts}
        active={statusFilter}
        onToggle={onToggleStatus}
      />
    </header>
  );
}
