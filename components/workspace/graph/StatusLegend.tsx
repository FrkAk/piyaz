'use client';

import { StatusGlyph, STATUS_META, type TaskStatus } from '@/components/shared/StatusGlyph';

interface StatusLegendProps {
  /** @param hiddenStatuses - Statuses currently hidden from the canvas. */
  hiddenStatuses: Set<string>;
  /** @param onToggleStatus - Click handler that flips a status in/out of `hiddenStatuses`. */
  onToggleStatus: (status: string) => void;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/** Display order — chronological lifecycle, mirrors the structure list groups. */
const ORDER: TaskStatus[] = [
  'draft',
  'planned',
  'ready',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

/**
 * Bottom-left legend for the workspace graph canvas. Each chip toggles the
 * matching status filter; hidden statuses dim and strike-through but stay in
 * place so the row reads as a control panel, not a flicker.
 *
 * @param props - Hidden statuses set + toggle callback.
 * @returns Translucent legend overlay.
 */
export function StatusLegend({ hiddenStatuses, onToggleStatus, className = '' }: StatusLegendProps) {
  return (
    <div
      className={`absolute bottom-4 left-4 z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border px-3 py-2 backdrop-blur-md ${className}`}
      style={{ background: 'color-mix(in srgb, var(--color-base) 82%, transparent)' }}
    >
      {ORDER.map((status) => {
        const meta = STATUS_META[status];
        const isHidden = hiddenStatuses.has(status);
        return (
          <button
            key={status}
            type="button"
            onClick={() => onToggleStatus(status)}
            aria-pressed={!isHidden}
            title={`${isHidden ? 'Show' : 'Hide'} ${meta.label}`}
            className="inline-flex cursor-pointer items-center gap-1.5 transition-opacity hover:opacity-100"
            style={{ opacity: isHidden ? 0.35 : 1 }}
          >
            <StatusGlyph status={status} size={11} />
            <span
              className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted"
              style={{ textDecoration: isHidden ? 'line-through' : 'none' }}
            >
              {meta.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default StatusLegend;
