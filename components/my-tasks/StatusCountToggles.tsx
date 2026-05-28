"use client";

import { STATUS_META } from "@/components/shared/StatusGlyph";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import type { TaskState } from "@/lib/data/task";
import { STATUS_TOGGLE_ORDER } from "./predicates";

interface StatusCountTogglesProps {
  viewCounts: Record<TaskState, number>;
  active: ReadonlySet<TaskState>;
  onToggle: (state: TaskState) => void;
}

// Skip zero-count chips so `0 done` never shows up while viewing Open.
export function StatusCountToggles({
  viewCounts,
  active,
  onToggle,
}: StatusCountTogglesProps) {
  const visible = STATUS_TOGGLE_ORDER.filter((s) => viewCounts[s] > 0);
  if (visible.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Filter by status"
    >
      {visible.map((state) => {
        const isActive = active.has(state);
        const meta = STATUS_META[state];
        return (
          <button
            key={state}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(state)}
            className={`inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors duration-150 ${
              isActive
                ? "border-accent/30 bg-accent/10 text-accent-light"
                : "border-border text-text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-text-primary"
            }`}
          >
            <StatusGlyph
              status={state}
              size={11}
              className={state === "in_progress" ? "status-pulse" : undefined}
            />
            <span className="font-mono font-semibold tabular-nums">
              {viewCounts[state]}
            </span>
            <span className={isActive ? "" : "text-text-muted"}>
              {meta.label.toLowerCase()}
            </span>
          </button>
        );
      })}
    </div>
  );
}
