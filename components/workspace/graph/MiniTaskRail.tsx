'use client';

import { useEffect, useMemo, useState } from 'react';
import { StatusGlyph } from '@/components/shared/StatusGlyph';
import { MonoId } from '@/components/shared/MonoId';
import { IconPanelLeft } from '@/components/shared/icons';
import type { TaskGraphSlim } from '@/lib/data/views';

/** localStorage key for the collapsed-state preference. */
const RAIL_STORAGE_KEY = 'mymir:graph-rail-collapsed';

/** Width of the rail when expanded. */
const RAIL_WIDTH_EXPANDED = 240;
/** Width of the rail when collapsed. */
const RAIL_WIDTH_COLLAPSED = 40;

interface MiniTaskRailProps {
  /** @param tasks - Tasks visible in the rail (already filtered upstream). */
  tasks: TaskGraphSlim[];
  /** @param selectedNodeId - Currently selected task id. */
  selectedNodeId: string | null;
  /** @param hoveredId - Hovered task id (rail-driven; mirrored on canvas). */
  hoveredId: string | null;
  /** @param onHover - Called with the hovered task id (or `null` on leave). */
  onHover: (id: string | null) => void;
  /** @param onSelect - Called when a row is clicked. */
  onSelect: (id: string) => void;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/**
 * Parse the trailing numeric segment of a `taskRef` (e.g. `MYMR-104` → 104).
 *
 * @param taskRef - Full task identifier.
 * @returns Numeric tail or 0.
 */
function refOrder(taskRef: string): number {
  const tail = taskRef.split('-').pop();
  const n = tail ? parseInt(tail, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the collapsed-state preference from localStorage with a safe SSR
 * fallback. Defaults to expanded for first-time operators.
 *
 * @returns `true` when the rail should start collapsed.
 */
function readInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Left rail for the workspace graph view. Defaults to a 240px Linear-density
 * list; collapses to a 40px icon strip via the chevron toggle so the canvas
 * gets the lion's share of the viewport when the operator wants it.
 *
 * Hovering a row propagates `onHover` to the canvas (matched node brightens);
 * clicking opens the task workspace just like a node click.
 *
 * @param props - Rail configuration.
 * @returns Left rail aside element.
 */
export function MiniTaskRail({
  tasks,
  selectedNodeId,
  hoveredId,
  onHover,
  onSelect,
  className = '',
}: MiniTaskRailProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readInitialCollapsed());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      /* swallow storage errors — preference is non-critical */
    }
  }, [collapsed]);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => refOrder(a.taskRef) - refOrder(b.taskRef)),
    [tasks],
  );

  const width = collapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH_EXPANDED;

  return (
    <aside
      aria-label="Graph nodes"
      className={`flex h-full min-h-0 flex-col border-r border-border bg-base-2 transition-[width] duration-200 ease-out ${className}`}
      style={{ width, flexShrink: 0 }}
    >
      <header
        className={`flex h-9 flex-shrink-0 items-center border-b border-border ${
          collapsed ? 'justify-center px-1' : 'gap-1.5 px-3'
        }`}
      >
        {!collapsed && (
          <>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-muted">
              Nodes
            </span>
            <span className="font-mono text-[10px] font-semibold tabular-nums text-text-faint">
              · {sorted.length}
            </span>
            <span className="flex-1" />
          </>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand node rail' : 'Collapse node rail'}
          title={collapsed ? 'Expand rail' : 'Collapse rail'}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <IconPanelLeft size={12} />
        </button>
      </header>
      <div
        className="flex-1 overflow-y-auto py-1"
        onMouseLeave={() => onHover(null)}
      >
        {sorted.map((t) => {
          const active = t.id === selectedNodeId;
          const hot = t.id === hoveredId && !active;
          if (collapsed) {
            return (
              <button
                key={t.id}
                type="button"
                onMouseEnter={() => onHover(t.id)}
                onClick={() => onSelect(t.id)}
                aria-current={active ? 'true' : undefined}
                title={`${t.taskRef} · ${t.title}`}
                className={`relative flex w-full cursor-pointer items-center justify-center py-1.5 transition-colors ${
                  active
                    ? 'bg-surface-hover'
                    : hot
                      ? 'bg-surface-hover/60'
                      : 'hover:bg-surface-hover/40'
                }`}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-sm"
                    style={{ background: 'var(--color-accent-grad)' }}
                  />
                )}
                <StatusGlyph status={t.status} size={11} />
              </button>
            );
          }
          return (
            <button
              key={t.id}
              type="button"
              onMouseEnter={() => onHover(t.id)}
              onClick={() => onSelect(t.id)}
              aria-current={active ? 'true' : undefined}
              className={`relative flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors ${
                active
                  ? 'bg-surface-hover'
                  : hot
                    ? 'bg-surface-hover/60'
                    : 'hover:bg-surface-hover/40'
              }`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-sm"
                  style={{ background: 'var(--color-accent-grad)' }}
                />
              )}
              <StatusGlyph status={t.status} size={11} />
              <MonoId id={t.taskRef} copyable={false} />
              <span
                className="flex-1 truncate text-[11.5px]"
                style={{
                  color:
                    active || hot
                      ? 'var(--color-text-primary)'
                      : 'var(--color-text-secondary)',
                }}
              >
                {t.title}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export default MiniTaskRail;
