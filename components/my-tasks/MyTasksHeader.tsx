"use client";

import type { TaskState } from "@/lib/data/task";
import { StatusCountToggles } from "./StatusCountToggles";

interface MyTasksHeaderProps {
  totalCount: number;
  viewCounts: Record<TaskState, number>;
  statusFilter: ReadonlySet<TaskState>;
  onToggleStatus: (state: TaskState) => void;
  dimTotal?: boolean;
}

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
        <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.01em] text-text-primary">
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
