"use client";

import { SectionHeader } from "@/components/shared/SectionHeader";
import { MonoId } from "@/components/shared/MonoId";
import { IconDoc } from "@/components/shared/icons";
import { skeletonVars } from "@/components/shared/skeleton";
import { asIdentifier, composeNoteRef } from "@/lib/graph/identifier";
import { NOTE_TYPE_META, tint } from "@/components/workspace/notes/note-meta";
import type { TaskNoteBacklink } from "@/lib/data/note";

interface LinkedNotesSectionProps {
  /** Deduped backlink rows, resolved once by the detail view. */
  rows: TaskNoteBacklink[];
  /** Whether the shared note-context read is still in flight. */
  isLoading: boolean;
  /** Whether the shared note-context read failed. */
  isError: boolean;
  /** Retry the shared note-context read. */
  onRetry: () => void;
  /** Composed task reference (e.g. `MYM-12`) for the empty-state copy. */
  taskRef: string;
  /** Project prefix (e.g. `MYM`) for the linked-note ref chip. */
  projectIdentifier: string;
  /** Open a linked note on the Notes surface. */
  onOpenNote: (noteId: string) => void;
}

/**
 * Linked-notes section for the task DetailView. Lists the notes that
 * reference this task (backlinks), each as a type-colored card that opens
 * the note on the Notes surface. Presentational: the detail view resolves
 * the note context once and threads both halves down, so this section and
 * the bundle preview share a single read.
 *
 * @param props - Section configuration.
 * @returns Section element with the backlinks list and its loading, empty,
 *   and error states.
 */
export function LinkedNotesSection({
  rows,
  isLoading,
  isError,
  onRetry,
  taskRef,
  projectIdentifier,
  onOpenNote,
}: LinkedNotesSectionProps) {
  return (
    <section className="mb-7">
      <SectionHeader
        label="Linked notes"
        count={rows.length > 0 ? rows.length : undefined}
      />

      {isLoading ? (
        <LinkedNotesSkeleton />
      ) : isError ? (
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-text-secondary">
          <span>Couldn’t load linked notes.</span>
          <button
            type="button"
            onClick={onRetry}
            className="text-text-faint underline hover:text-text-secondary"
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/70 bg-surface-raised/10 px-4 py-3.5">
          <span className="font-mono text-[11px] tracking-wide text-text-muted">
            No notes linked to {taskRef}.
          </span>
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <LinkedNoteCard
              key={row.id}
              row={row}
              projectIdentifier={projectIdentifier}
              onOpen={() => onOpenNote(row.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface LinkedNoteCardProps {
  /** Backlink row projection. */
  row: TaskNoteBacklink;
  /** Project prefix for the ref chip. */
  projectIdentifier: string;
  /** Open this note. */
  onOpen: () => void;
}

/**
 * Single linked-note card: type-colored {@link IconDoc}, note ref chip,
 * title, type chip, and a clamped summary. The whole card is a button that
 * opens the note. The header row stays on one line: the title truncates
 * while the icon, ref, and type chip hold their width, so it never reflows
 * or overflows at narrow widths.
 *
 * @param props - Card configuration.
 * @returns Card button element.
 */
function LinkedNoteCard({
  row,
  projectIdentifier,
  onOpen,
}: LinkedNoteCardProps) {
  const meta = NOTE_TYPE_META[row.type] ?? NOTE_TYPE_META.reference;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/note flex w-full cursor-pointer flex-col gap-1.5 rounded-md border border-border/40 bg-transparent px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface-raised/40"
    >
      <div className="flex w-full items-center gap-2">
        <IconDoc size={14} className="shrink-0" style={{ color: meta.color }} />
        <MonoId
          id={composeNoteRef(
            asIdentifier(projectIdentifier),
            row.sequenceNumber,
          )}
          copyable={false}
          className="shrink-0"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary transition-colors group-hover/note:text-accent-light">
          {row.title}
        </span>
        <span
          className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
          style={{ color: meta.color, background: tint(meta.color, 13) }}
        >
          {meta.label}
        </span>
      </div>
      {row.summary !== "" && (
        <p className="line-clamp-2 pl-[22px] text-[11px] leading-snug text-text-muted">
          {row.summary}
        </p>
      )}
    </button>
  );
}

/**
 * Loading placeholder for the linked-notes list. Renders two skeleton card
 * rows using the shared `skeleton-bar` + `rise-in` vocabulary; the global
 * reduced-motion rule already stills the animation.
 *
 * @returns Skeleton element for the section body.
 */
function LinkedNotesSkeleton() {
  return (
    <div className="space-y-1.5">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rise-in flex flex-col gap-1.5 rounded-md border border-border/40 px-2.5 py-2"
          style={skeletonVars({ "--skeleton-delay": `${i * 70}ms` })}
        >
          <div className="flex items-center gap-2">
            <div
              className="skeleton-bar h-3.5 w-3.5 shrink-0"
              style={skeletonVars({ "--skeleton-radius": "3px" })}
            />
            <div className="skeleton-bar h-3 w-14" />
            <div className="skeleton-bar h-3 w-2/5" />
          </div>
          <div className="skeleton-bar ml-[22px] h-2.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export default LinkedNotesSection;
