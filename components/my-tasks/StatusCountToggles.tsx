"use client";

import { STATUS_META } from "@/components/shared/StatusGlyph";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import type { TaskState } from "@/lib/data/task";
import { STATUS_TOGGLE_ORDER } from "./predicates";

interface StatusCountTogglesProps {
  /** Per-state counts derived from the currently-filtered view. */
  viewCounts: Record<TaskState, number>;
  /** Active status filter set — chips for states in the set render as pressed. */
  active: ReadonlySet<TaskState>;
  /** Toggle handler — clicking a chip adds the state when absent, removes when present. */
  onToggle: (state: TaskState) => void;
}

/**
 * Clickable status-count chips. Multi-select per HOTL preference: clicking
 * a chip toggles its membership in the active set. Only chips with at
 * least one task in the active view are rendered so the operator never
 * sees `0 done` while looking at Open. The set state is owned by the
 * parent and mirrored to the URL.
 *
 * @param props - View counts + active set + toggle handler.
 * @returns Row of pill buttons.
 */
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
            className={`inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full border px-[9px] text-[11.5px] transition-colors duration-150 ${
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
