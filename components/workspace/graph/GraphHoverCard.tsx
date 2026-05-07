'use client';

import { StatusGlyph } from '@/components/shared/StatusGlyph';
import { MonoId } from '@/components/shared/MonoId';
import { IconArrowRight } from '@/components/shared/icons';
import type { TaskGraphSlim } from '@/lib/data/views';

interface GraphHoverCardProps {
  /** @param task - Hovered task. */
  task: TaskGraphSlim;
  /** @param upstreamCount - Count of incoming edges (shown as `↑N`). */
  upstreamCount: number;
  /** @param downstreamCount - Count of outgoing edges (shown as `↓N`). */
  downstreamCount: number;
  /** @param onOpen - Click handler that selects/opens the hovered task. */
  onOpen: () => void;
}

/**
 * Floating preview card pinned top-right of the graph canvas. Surfaces the
 * essentials of whichever node the operator is hovering — status, identifier,
 * dependency hints, title — without committing them to opening the full task
 * workspace. Click anywhere on the card to open the detail panel.
 *
 * @param props - Hovered task + edge counts + open handler.
 * @returns Clickable preview card.
 */
export function GraphHoverCard({ task, upstreamCount, downstreamCount, onOpen }: GraphHoverCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-[320px] cursor-pointer rounded-[10px] border border-border-strong bg-surface p-3.5 text-left shadow-[var(--shadow-float)] transition-colors hover:border-accent/40"
      title={`Open ${task.taskRef}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <StatusGlyph status={task.status} size={12} />
        <MonoId id={task.taskRef} copyable={false} />
        <span className="flex-1" />
        <span className="font-mono text-[10px] tabular-nums text-text-faint">
          ↑{upstreamCount} ↓{downstreamCount}
        </span>
      </div>
      <div className="mb-2 line-clamp-2 text-[13px] font-medium leading-[1.35] text-text-primary">
        {task.title}
      </div>
      <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[11px] text-text-muted">
        <span>Open task</span>
        <span aria-hidden="true" className="text-accent-light">
          <IconArrowRight size={10} />
        </span>
      </div>
    </button>
  );
}

export default GraphHoverCard;
