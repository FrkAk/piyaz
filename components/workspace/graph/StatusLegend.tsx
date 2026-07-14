"use client";

import {
  StatusGlyph,
  STATUS_META,
  type TaskStatus,
} from "@/components/shared/StatusGlyph";
import { NOTE_EDGE_GRAY } from "@/components/graph/graphConstants";

interface StatusLegendProps {
  /** @param hiddenStatuses - Statuses currently hidden from the canvas. */
  hiddenStatuses: Set<string>;
  /** @param onToggleStatus - Click handler that flips a status in/out of `hiddenStatuses`. */
  onToggleStatus: (status: string) => void;
  /** @param noteCount - Project note count. At 0 the Notes chip (and its
   *   divider) render nothing, keeping zero-note chrome identical to before. */
  noteCount?: number;
  /** @param fedCount - Count of auto-fed notes. Above 0 a passive key
   *   entry decodes the corner-dot marker; it is not a filter. */
  fedCount?: number;
  /** @param notesHidden - Whether note nodes are hidden from the canvas. */
  notesHidden?: boolean;
  /** @param onToggleNotes - Flips the Notes visibility toggle. */
  onToggleNotes?: () => void;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/** Display order — chronological lifecycle, mirrors the structure list groups. */
const ORDER: TaskStatus[] = [
  "draft",
  "planned",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

/**
 * Bottom-left legend for the workspace graph canvas. Each chip toggles the
 * matching status filter; hidden statuses dim and strike-through but stay in
 * place so the row reads as a control panel, not a flicker. Projects with
 * notes get one extra Notes chip after a divider — same toggle affordance,
 * rounded-square swatch matching the canvas note shape.
 *
 * @param props - Hidden statuses set + toggle callbacks.
 * @returns Translucent legend overlay.
 */
export function StatusLegend({
  hiddenStatuses,
  onToggleStatus,
  noteCount = 0,
  fedCount = 0,
  notesHidden = false,
  onToggleNotes,
  className = "",
}: StatusLegendProps) {
  return (
    <div
      className={`absolute bottom-4 left-4 z-10 flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border px-3 py-2 backdrop-blur-md ${className}`}
      style={{
        background: "color-mix(in srgb, var(--color-base) 82%, transparent)",
      }}
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
            title={`${isHidden ? "Show" : "Hide"} ${meta.label}`}
            className="inline-flex cursor-pointer items-center gap-1.5 transition-opacity hover:opacity-100 pointer-coarse:min-h-11"
            style={{ opacity: isHidden ? 0.35 : 1 }}
          >
            <StatusGlyph status={status} size={11} />
            <span
              className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted"
              style={{ textDecoration: isHidden ? "line-through" : "none" }}
            >
              {meta.label}
            </span>
          </button>
        );
      })}
      {noteCount > 0 && onToggleNotes && (
        <>
          <span aria-hidden className="h-3 w-px bg-border" />
          <button
            type="button"
            onClick={onToggleNotes}
            aria-pressed={!notesHidden}
            title={`${notesHidden ? "Show" : "Hide"} Notes`}
            className="inline-flex cursor-pointer items-center gap-1.5 transition-opacity hover:opacity-100 pointer-coarse:min-h-11"
            style={{ opacity: notesHidden ? 0.35 : 1 }}
          >
            {/* Neutral notes-layer gray, NOT a type color — a violet swatch
                reads as the knowledge type instead of "all notes". */}
            <span
              aria-hidden
              className="inline-block rounded-[3px]"
              style={{
                width: 10,
                height: 10,
                border: `1.5px solid ${NOTE_EDGE_GRAY}`,
                background: `color-mix(in srgb, ${NOTE_EDGE_GRAY} 18%, transparent)`,
              }}
            />
            <span
              className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted"
              style={{
                textDecoration: notesHidden ? "line-through" : "none",
              }}
            >
              Notes
            </span>
          </button>
          {/* Passive key — decodes the corner-dot marker on note nodes;
              deliberately not a filter, so no button semantics. */}
          {fedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 pointer-coarse:min-h-11">
              <span
                aria-hidden
                className="relative inline-block rounded-[3px]"
                style={{
                  width: 10,
                  height: 10,
                  border: `1.5px solid ${NOTE_EDGE_GRAY}`,
                  background: `color-mix(in srgb, ${NOTE_EDGE_GRAY} 18%, transparent)`,
                }}
              >
                <span
                  className="absolute rounded-full"
                  style={{
                    width: 4,
                    height: 4,
                    top: -2,
                    right: -2,
                    background: NOTE_EDGE_GRAY,
                  }}
                />
              </span>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Auto-fed
              </span>
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default StatusLegend;
