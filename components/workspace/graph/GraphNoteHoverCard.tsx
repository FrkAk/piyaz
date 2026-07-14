"use client";

import { MonoId } from "@/components/shared/MonoId";
import { IconArrowRight } from "@/components/shared/icons";
import { NoteSquareGlyph } from "@/components/workspace/graph/NoteSquareGlyph";
import { NOTE_TYPE_META, tint } from "@/components/workspace/notes/note-meta";
import type { NoteGraphSlim } from "@/lib/data/views";

interface GraphNoteHoverCardProps {
  /** @param note - Hovered note. */
  note: NoteGraphSlim;
  /** @param taskLinkCount - Count of tasks this note links to. */
  taskLinkCount: number;
  /** @param noteLinkCount - Count of notes linked in either direction. */
  noteLinkCount: number;
  /** @param onOpen - Click handler that opens the note preview. */
  onOpen: () => void;
}

/**
 * Floating preview card pinned top-right of the graph canvas — the note
 * counterpart of {@link GraphHoverCard}. Surfaces the hovered note's type,
 * ref, title, and link counts without committing to opening the preview
 * panel. Click anywhere on the card to open it.
 *
 * @param props - Hovered note + link counts + open handler.
 * @returns Clickable preview card.
 */
export function GraphNoteHoverCard({
  note,
  taskLinkCount,
  noteLinkCount,
  onOpen,
}: GraphNoteHoverCardProps) {
  const meta = NOTE_TYPE_META[note.type];
  const counts = [
    taskLinkCount > 0
      ? `${taskLinkCount} task${taskLinkCount === 1 ? "" : "s"}`
      : null,
    noteLinkCount > 0
      ? `${noteLinkCount} note${noteLinkCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-[320px] cursor-pointer rounded-[10px] border border-border-strong bg-surface p-3.5 text-left shadow-[var(--shadow-float)] transition-colors hover:border-accent/40"
      title={`Preview ${note.noteRef}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <NoteSquareGlyph color={meta.color} size={12} fed={note.fed} />
        <MonoId id={note.noteRef} copyable={false} tone="default" />
        <span className="flex-1" />
        {note.fed && (
          <span
            className="rounded px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-[0.06em]"
            style={{
              color: meta.color,
              background: tint(meta.color, 12),
              border: `1px solid ${tint(meta.color, 32)}`,
            }}
          >
            Auto-fed
          </span>
        )}
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: meta.color }}
        >
          {meta.label}
        </span>
      </div>
      <div className="mb-2 line-clamp-2 text-[13px] font-medium leading-[1.35] text-text-primary">
        {note.title || "Untitled"}
      </div>
      <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[11px] text-text-muted">
        <span>Click node to preview</span>
        <span aria-hidden="true" className="text-accent-light">
          <IconArrowRight size={10} />
        </span>
        <span className="flex-1" />
        {counts !== "" && (
          <span className="font-mono text-[10px] tabular-nums text-text-faint">
            {counts}
          </span>
        )}
      </div>
    </button>
  );
}

export default GraphNoteHoverCard;
