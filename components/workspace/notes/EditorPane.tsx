"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAgent,
  IconBundle,
  IconLock,
  IconUser,
  IconUsers,
} from "@/components/shared/icons";
import { MonoId } from "@/components/shared/MonoId";
import type { LinkedNoteSlim, NoteFull, NoteMention } from "@/lib/data/note";
import { formatRelative } from "@/lib/ui/relative-time";
import { LiveEditor } from "./LiveEditor";
import { NOTE_TYPE_META, tint } from "./note-meta";
import { NoteLinkContext, type NoteLinkContextValue } from "./NoteInline";
import { useNoteDetail } from "./useNoteDetail";
import { useNoteAutosave } from "./useNoteMutations";

interface EditorPaneProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param projectIdentifier - Owning project identifier for inline task refs. */
  projectIdentifier: string;
  /** @param noteId - Selected note id, or null. */
  noteId: string | null;
  /** @param focusTitle - Note id whose title input should take focus, or null. */
  focusTitle: string | null;
  /** @param onFocusedTitle - Clears the focus request once applied. */
  onFocusedTitle: () => void;
  /** @param onSelectTask - Opens a task's detail from an inline chip. */
  onSelectTask: (taskId: string) => void;
  /** @param onSelectNote - Selects another note from an inline link. */
  onSelectNote: (noteId: string) => void;
}

/**
 * Center pane, the editor column. Renders the empty state without a
 * selection, otherwise the note header, editable title, and the live
 * block editor.
 *
 * @param props - Project scope, selection, navigation, and title-focus wiring.
 * @returns The flexible editor column.
 */
export function EditorPane({
  projectId,
  projectIdentifier,
  noteId,
  focusTitle,
  onFocusedTitle,
  onSelectTask,
  onSelectNote,
}: EditorPaneProps) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ background: "var(--color-base)" }}
    >
      {noteId === null ? (
        <div className="flex h-full items-center justify-center">
          <p className="text-[12px] text-text-muted">No note selected</p>
        </div>
      ) : (
        <EditorBody
          key={noteId}
          projectId={projectId}
          projectIdentifier={projectIdentifier}
          noteId={noteId}
          shouldFocusTitle={focusTitle === noteId}
          onFocusedTitle={onFocusedTitle}
          onSelectTask={onSelectTask}
          onSelectNote={onSelectNote}
        />
      )}
    </div>
  );
}

interface EditorBodyProps {
  projectId: string;
  projectIdentifier: string;
  noteId: string;
  shouldFocusTitle: boolean;
  onFocusedTitle: () => void;
  onSelectTask: (taskId: string) => void;
  onSelectNote: (noteId: string) => void;
}

/** Shared pill chip classes for the header row. */
const PILL_CLASS =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase";

/**
 * Loaded-note body: header chip row, editable H1 title, meta line with
 * save status, feed banner, and the live block editor. Mounted only with
 * a live selection so the detail query is never keyed on an empty id;
 * remounted per note via `key`. An uncommitted title is flushed on
 * unmount so a selection change without a blur never drops the edit; the
 * title commit shares the autosave buffer with body edits, so a title and
 * a buffered body write fold into one CAS-serialized patch and can never
 * race each other's `updatedAt` token. Body edits
 * stay gated on `isPlaceholderData`: while the placeholder (empty body)
 * is live, a skeleton renders instead of the editor so no block commit
 * can reach autosave.
 *
 * @param props - Selected note, navigation, and title-focus wiring.
 * @returns The note content column, a not-found line, or null while loading.
 */
function EditorBody({
  projectId,
  projectIdentifier,
  noteId,
  shouldFocusTitle,
  onFocusedTitle,
  onSelectTask,
  onSelectNote,
}: EditorBodyProps) {
  const { data, isPlaceholderData, isError } = useNoteDetail(projectId, noteId);
  const autosave = useNoteAutosave(projectId, noteId);
  const note = data?.note;
  const [title, setTitle] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (title === null && note !== undefined) setTitle(note.title);

  const ready = note !== undefined;
  useEffect(() => {
    if (!shouldFocusTitle || !ready) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
    onFocusedTitle();
  }, [shouldFocusTitle, ready, onFocusedTitle]);

  const commitRef = useRef<() => void>(() => {});
  useEffect(() => {
    commitRef.current = () => {
      if (note === undefined || note.locked) return;
      if (title === null || title === note.title) return;
      autosave.commit({ title });
      void autosave.flush();
    };
  });
  useEffect(() => () => commitRef.current(), []);

  const mentionsBySeq = useMemo(() => {
    const map = new Map<number, NoteMention>();
    for (const mention of data?.mentions ?? []) {
      const seq = Number(
        mention.taskRef.slice(mention.taskRef.lastIndexOf("-") + 1),
      );
      if (Number.isSafeInteger(seq)) map.set(seq, mention);
    }
    return map;
  }, [data?.mentions]);

  const notesByTitle = useMemo(() => {
    const map = new Map<string, LinkedNoteSlim>();
    for (const linked of data?.linksOut ?? []) {
      map.set(linked.title.toLowerCase(), linked);
    }
    return map;
  }, [data?.linksOut]);

  const linkContext = useMemo<NoteLinkContextValue>(
    () => ({
      identifier: projectIdentifier,
      mentionsBySeq,
      notesByTitle,
      onTask: onSelectTask,
      onNote: onSelectNote,
    }),
    [
      projectIdentifier,
      mentionsBySeq,
      notesByTitle,
      onSelectTask,
      onSelectNote,
    ],
  );

  if (note === undefined) {
    if (!isError) return null;
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12px] text-text-muted">Note not found</p>
      </div>
    );
  }

  const meta = NOTE_TYPE_META[note.type];
  const editable = !note.locked && !isPlaceholderData;

  return (
    <div
      className="mx-auto"
      style={{ maxWidth: 760, padding: "28px 34px 64px" }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MonoId id={note.slug.toUpperCase()} copyable={false} />
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase"
          style={{
            color: meta.color,
            background: tint(meta.color, 13),
            border: `1px solid ${tint(meta.color, 26)}`,
          }}
        >
          {meta.label}
        </span>
        <span
          className={PILL_CLASS}
          style={{
            color:
              note.visibility === "team"
                ? "var(--color-done)"
                : "var(--color-text-muted)",
            background:
              note.visibility === "team"
                ? "var(--color-done-bg)"
                : "var(--color-surface-hover)",
            border: "1px solid var(--color-border)",
          }}
        >
          {note.visibility === "team" ? (
            <IconUsers size={10} />
          ) : (
            <IconUser size={10} />
          )}
          {note.visibility}
        </span>
        {note.locked && (
          <span
            className={PILL_CLASS}
            style={{
              color: "var(--color-danger)",
              background: tint("var(--color-danger)", 12),
              border: `1px solid ${tint("var(--color-danger)", 30)}`,
            }}
          >
            <IconLock size={10} /> locked
          </span>
        )}
        {!note.agentWritable && (
          <span
            className={PILL_CLASS}
            style={{
              color: "var(--color-glyph-review)",
              background: tint("var(--color-glyph-review)", 12),
              border: `1px solid ${tint("var(--color-glyph-review)", 30)}`,
            }}
          >
            <IconAgent size={10} /> agent read-only
          </span>
        )}
        {note.locked && (
          <span className="ml-auto font-mono text-[10px] text-text-faint">
            locked — unlock to edit
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        value={title ?? ""}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => commitRef.current()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitRef.current();
        }}
        readOnly={note.locked}
        placeholder="Untitled note"
        className="mb-2.5 w-full bg-transparent outline-none placeholder:text-text-faint"
        style={{
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--color-text-primary)",
        }}
      />

      <div className="mb-5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
        <span>updated {formatRelative(note.updatedAt)}</span>
        {autosave.pending ? (
          <span className="ml-auto font-mono text-[10px] text-text-faint">
            saving…
          </span>
        ) : autosave.saveError !== null ? (
          <span
            className="ml-auto font-mono text-[10px]"
            style={{ color: "var(--color-danger)" }}
          >
            save failed · {autosave.saveError.code}
          </span>
        ) : null}
      </div>

      {note.feedMode !== "none" && (
        <Banner color={meta.color} icon={<IconBundle size={13} />}>
          <strong
            style={{ color: "var(--color-text-primary)", fontWeight: 600 }}
          >
            Auto-fed
          </strong>{" "}
          into {feedSummary(note)}.
        </Banner>
      )}

      {isPlaceholderData ? (
        <BodySkeleton />
      ) : (
        <NoteLinkContext.Provider value={linkContext}>
          <LiveEditor
            body={note.body}
            editable={editable}
            onCommitBody={(next) => autosave.commit({ body: next })}
          />
        </NoteLinkContext.Provider>
      )}
    </div>
  );
}

/**
 * Human summary of where a note auto-feeds into tasks.
 *
 * @param note - The note's feed targeting columns.
 * @returns The banner phrase for the note's feed mode.
 */
function feedSummary(note: NoteFull): string {
  switch (note.feedMode) {
    case "all":
      return "every task in this project";
    case "categories":
      return `tasks in ${note.feedCategories.join(", ") || "—"}`;
    case "tags":
      return `tasks tagged ${note.feedTags.join(", ") || "—"}`;
    case "tasks":
      return `${note.feedTaskIds.length} selected task${note.feedTaskIds.length === 1 ? "" : "s"}`;
    default:
      return "";
  }
}

interface BannerProps {
  /** @param color - Note-type token driving the tints. */
  color: string;
  /** @param icon - Leading icon element. */
  icon: React.ReactNode;
  /** @param children - Banner copy. */
  children: React.ReactNode;
}

/**
 * Type-tinted inline banner for the auto-feed notice.
 *
 * @param props - Tint color, icon, and copy.
 * @returns The banner row.
 */
function Banner({ color, icon, children }: BannerProps) {
  return (
    <div
      className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] leading-relaxed"
      style={{
        background: tint(color, 8),
        border: `1px solid ${tint(color, 32)}`,
        color: "var(--color-text-secondary)",
      }}
    >
      <span style={{ color, marginTop: 1 }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Pulsing body placeholder shown while the detail fetch resolves, so the
 * placeholder's empty body never flashes as editable blocks.
 *
 * @returns The decorative three-line skeleton.
 */
function BodySkeleton() {
  return (
    <div className="pt-1">
      <span className="sr-only">Loading note</span>
      {[220, 340, 280].map((width) => (
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
