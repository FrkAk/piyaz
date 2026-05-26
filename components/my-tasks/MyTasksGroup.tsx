"use client";

import { STATUS_META } from "@/components/shared/StatusGlyph";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { IconChevronDown } from "@/components/shared/icons";
import type { TaskState } from "@/lib/data/task";

interface MyTasksGroupProps {
  /** Derived state shared by every row inside the group. */
  state: TaskState;
  /** Row count rendered as a mono tail count. */
  count: number;
  /** Whether the group body is currently collapsed. */
  collapsed: boolean;
  /**
   * Toggle handler. When `null`, the chevron does not render — the parent
   * locks the open state (every group except `done` is always open in v1).
   */
  onToggle: (() => void) | null;
}

/**
 * Sticky 30px group header inside the list card. Mono uppercase label,
 * leading `<StatusGlyph>`, trailing row count, chevron that rotates on
 * collapse. The container is `sticky top-0` so the header pins to the top
 * of the page scroll container while its rows scroll past.
 *
 * @param props - State + count + collapse state and handler.
 * @returns Group header row.
 */
export function MyTasksGroup({
  state,
  count,
  collapsed,
  onToggle,
}: MyTasksGroupProps) {
  const meta = STATUS_META[state];
  const content = (
    <>
      {onToggle && (
        <span
          aria-hidden="true"
          className="inline-flex text-text-muted transition-transform duration-150"
          style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
        >
          <IconChevronDown size={9} />
        </span>
      )}
      <StatusGlyph status={state} size={11} />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
        {meta.label}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-text-muted">
        {count}
      </span>
    </>
  );

  if (onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="sticky top-0 z-10 flex h-[30px] w-full cursor-pointer items-center gap-2 border-b border-border bg-surface/70 px-3.5 backdrop-blur transition-colors hover:bg-surface-hover/70"
      >
        {content}
      </button>
    );
  }
  return (
    <div className="sticky top-0 z-10 flex h-[30px] w-full items-center gap-2 border-b border-border bg-surface/70 px-3.5 backdrop-blur">
      {content}
    </div>
  );
}
