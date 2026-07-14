"use client";

import { useMemo } from "react";
import { Button } from "@/components/shared/Button";
import { IconButton } from "@/components/shared/IconButton";
import { IconX } from "@/components/shared/icons";
import { MonoId } from "@/components/shared/MonoId";
import { StatusGlyph, STATUS_META } from "@/components/shared/StatusGlyph";
import {
  NoteLinkContext,
  type NoteLinkContextValue,
  type NoteLinkTarget,
  type NoteTaskTarget,
} from "@/components/workspace/notes/NoteInline";
import { NoteMarkdown } from "@/components/workspace/notes/NoteMarkdown";
import { Pill } from "@/components/workspace/notes/Pill";
import {
  NOTE_TYPE_META,
  feedSummary,
  tint,
} from "@/components/workspace/notes/note-meta";
import { NoteSquareGlyph } from "@/components/workspace/graph/NoteSquareGlyph";
import { useNoteDetail } from "@/components/workspace/notes/useNoteDetail";
import { asIdentifier, composeNoteRef } from "@/lib/graph/identifier";
import type { NoteGraphSlim } from "@/lib/data/views";
import type { NoteMention } from "@/lib/data/note";
import { NOTE_TASK_LINK_KIND_RANK, type TaskStatus } from "@/lib/types";

interface NotePreviewPanelProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param noteId - Selected note id — mount only with a live selection. */
  noteId: string;
  /** @param slim - The note's slim graph row. Renders the panel chrome
   *   (ref, type, title, fed dot) synchronously so rapid note→note swaps
   *   never flash a blank panel while the detail fetch is in flight. */
  slim: NoteGraphSlim;
  /** @param projectIdentifier - Identifier for composing refs. */
  projectIdentifier: string;
  /** @param taskMap - Graph task map — resolves inline task-ref chips. */
  taskMap: ReadonlyMap<
    string,
    { title: string; status: string; taskRef: string }
  >;
  /** @param notes - Slim graph notes — resolve `[[wiki]]` links without a
   *   tree fetch. */
  notes: NoteGraphSlim[];
  /** @param onClose - Close the preview (clears the graph note selection). */
  onClose: () => void;
  /** @param onOpenInNotes - Jump to the full notes surface for editing. */
  onOpenInNotes: (noteId: string) => void;
  /** @param onSelectTask - Open a task from a chip or mention row. */
  onSelectTask: (taskId: string) => void;
  /** @param onSelectNote - Swap the preview to another note. */
  onSelectNote: (noteId: string) => void;
}

/**
 * Read-only note preview for the graph view's right slide-over — the note
 * counterpart of the task detail panel. Renders title, type, fed status,
 * the body through {@link NoteMarkdown} (task chips and wiki links resolve
 * from graph data already in memory), and the note's links. Never mounts
 * an editor; "Open in Notes" hands off to the full surface.
 *
 * @param props - Selection, resolution maps, and navigation callbacks.
 * @returns Preview panel column.
 */
export function NotePreviewPanel({
  projectId,
  noteId,
  slim,
  projectIdentifier,
  taskMap,
  notes,
  onClose,
  onOpenInNotes,
  onSelectTask,
  onSelectNote,
}: NotePreviewPanelProps) {
  const { data, isPlaceholderData, isError, refetch } = useNoteDetail(
    projectId,
    noteId,
  );
  // The tree-seeded placeholder fabricates `body: ""` and `feedMode:
  // "none"` — treating it as loaded would flash the empty-body state and
  // drop the fed marker, so body, fed, and links render only from real
  // detail data; chrome keeps falling back to the slim row.
  const detail = isPlaceholderData ? undefined : data;

  const tasksBySeq = useMemo(() => {
    const map = new Map<number, NoteTaskTarget>();
    for (const [taskId, task] of taskMap) {
      const seq = Number(task.taskRef.slice(task.taskRef.lastIndexOf("-") + 1));
      if (Number.isSafeInteger(seq)) {
        map.set(seq, {
          taskId,
          title: task.title,
          status: task.status as TaskStatus,
        });
      }
    }
    return map;
  }, [taskMap]);

  const notesByTitle = useMemo(() => {
    const map = new Map<string, NoteLinkTarget>();
    for (const n of notes) {
      const key = n.title.trim().toLowerCase();
      if (key !== "" && !map.has(key)) {
        map.set(key, { id: n.id, title: n.title, type: n.type });
      }
    }
    return map;
  }, [notes]);

  const linkContext = useMemo<NoteLinkContextValue>(
    () => ({
      identifier: projectIdentifier,
      tasksBySeq,
      notesByTitle,
      onTask: onSelectTask,
      onNote: onSelectNote,
    }),
    [projectIdentifier, tasksBySeq, notesByTitle, onSelectTask, onSelectNote],
  );

  const note = detail?.note;
  // One row per task, strongest kind wins — a body mention plus a
  // deliberate spec_of on the same task must not list twice.
  const taskLinks = detail
    ? [
        ...detail.mentions
          .reduce((byTask, m) => {
            const existing = byTask.get(m.taskId);
            if (
              !existing ||
              NOTE_TASK_LINK_KIND_RANK[m.kind] >
                NOTE_TASK_LINK_KIND_RANK[existing.kind]
            ) {
              byTask.set(m.taskId, m);
            }
            return byTask;
          }, new Map<string, NoteMention>())
          .values(),
      ]
    : [];
  // A note that links out AND is linked back lands in both directions —
  // dedupe by id or React sees two children with one key.
  const noteLinks = detail
    ? [
        ...new Map(
          [...detail.linksOut, ...detail.linksIn].map(
            (n) => [n.id, n] as const,
          ),
        ).values(),
      ]
    : [];
  // Chrome renders from the slim graph row synchronously; the fetched
  // detail takes over field-by-field when it lands. Rapid note→note swaps
  // therefore restyle in place instead of flashing an empty panel.
  const type = note?.type ?? slim.type;
  const title = note?.title ?? slim.title;
  const fed = note ? note.feedMode !== "none" : slim.fed;
  const meta = NOTE_TYPE_META[type];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <NoteSquareGlyph color={meta.color} fed={fed} />
        <MonoId id={slim.noteRef} copyable={false} tone="default" />
        <Pill inline color={meta.color} title={meta.blurb}>
          {meta.label}
        </Pill>
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onOpenInNotes(noteId)}
        >
          Open in Notes
        </Button>
        <IconButton label="Close note preview" onClick={onClose}>
          <IconX size={14} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h2 className="mb-2 text-[15px] font-semibold text-text-primary">
          {title || "Untitled"}
        </h2>

        {note === undefined && isError && (
          <div className="flex items-center gap-2 py-4 text-[12px] text-text-muted">
            <span>Note not found.</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="cursor-pointer text-text-secondary underline hover:text-text-primary"
            >
              Retry
            </button>
          </div>
        )}
        {note === undefined && !isError && <PreviewSkeleton />}

        {note !== undefined && fed && (
          <div
            className="mb-3 rounded-md px-2.5 py-1.5 text-[11.5px] text-text-secondary"
            style={{
              background: tint(meta.color, 8),
              border: `1px solid ${tint(meta.color, 32)}`,
            }}
          >
            <strong className="font-semibold text-text-primary">
              Auto-fed
            </strong>{" "}
            into {feedSummary(note)}.
          </div>
        )}

        {note !== undefined &&
          (note.body.trim() === "" ? (
            <p className="text-[12px] text-text-muted">No content yet.</p>
          ) : (
            <NoteLinkContext.Provider value={linkContext}>
              <NoteMarkdown body={note.body} identifier={projectIdentifier} />
            </NoteLinkContext.Provider>
          ))}

        {(taskLinks.length > 0 || noteLinks.length > 0) && (
          <div className="mt-4 border-t border-border pt-3">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-muted">
              Links
            </span>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {taskLinks.map((m) => (
                <li key={`task-${m.taskId}`}>
                  <button
                    type="button"
                    onClick={() => onSelectTask(m.taskId)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-surface-hover/60"
                  >
                    <StatusGlyph status={m.status} size={11} />
                    <MonoId id={m.taskRef} copyable={false} tone="default" />
                    <span className="flex-1 truncate text-[11.5px] text-text-secondary">
                      {m.title}
                    </span>
                    <span className="font-mono text-[10px] text-text-faint">
                      {STATUS_META[m.status].label}
                    </span>
                  </button>
                </li>
              ))}
              {noteLinks.map((n) => (
                <li key={`note-${n.id}`}>
                  <button
                    type="button"
                    onClick={() => onSelectNote(n.id)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-surface-hover/60"
                  >
                    <NoteSquareGlyph color={NOTE_TYPE_META[n.type].color} />
                    <MonoId
                      id={composeNoteRef(
                        asIdentifier(projectIdentifier),
                        n.sequenceNumber,
                      )}
                      copyable={false}
                      tone="default"
                    />
                    <span className="flex-1 truncate text-[11.5px] text-text-secondary">
                      {n.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pulsing line placeholder shown in the preview body while the detail
 * fetch resolves — mirrors the notes editor's `BodySkeleton` so loading
 * reads the same across both surfaces.
 *
 * @returns The decorative four-line skeleton.
 */
function PreviewSkeleton() {
  return (
    <div className="pt-1">
      <span className="sr-only">Loading note</span>
      {[240, 320, 200, 280].map((width) => (
        <div
          key={width}
          aria-hidden="true"
          className="flex items-center"
          style={{ height: 22 }}
        >
          <span
            className="h-2 animate-pulse rounded bg-surface-hover"
            style={{ width }}
          />
        </div>
      ))}
    </div>
  );
}

export default NotePreviewPanel;
