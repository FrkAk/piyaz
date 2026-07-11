"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconAgent,
  IconBundle,
  IconLock,
  IconUser,
  IconUsers,
  IconX,
} from "@/components/shared/icons";
import { Avatar } from "@/components/shared/Avatar";
import { MonoId } from "@/components/shared/MonoId";
import { useSession } from "@/lib/auth-client";
import type { NoteFull } from "@/lib/data/note";
import { asIdentifier, composeNoteRef } from "@/lib/graph/identifier";
import { noteKeys } from "@/lib/query/keys";
import { fetchNotesTree } from "@/lib/query/queries";
import { useNotePresence } from "@/lib/realtime/presence-store";
import type { TaskStatus, Visibility } from "@/lib/types";
import { formatRelative } from "@/lib/ui/relative-time";
import { ConflictBanner } from "./ConflictBanner";
import { NoteEditor } from "./NoteEditor";
import { useNotePresenceHeartbeat } from "./usePresenceHeartbeat";
import { NOTE_TYPE_META, tint } from "./note-meta";
import {
  shouldAdoptServerTitle,
  shouldClearDirty,
  shouldCommitTitle,
} from "./title-reconcile";
import {
  NoteLinkContext,
  type NoteLinkContextValue,
  type NoteLinkTarget,
  type NoteTaskTarget,
} from "./NoteInline";
import { useNoteDetail } from "./useNoteDetail";
import { useNoteAutosave } from "./useNoteMutations";

/** Slim project task map keyed by task id, threaded from the workspace. */
export type TaskSlimMap = ReadonlyMap<
  string,
  { title: string; status: string; taskRef: string }
>;

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
  /** @param onSelectNote - Selects another note from an inline link; null closes the open note. */
  onSelectNote: (noteId: string | null) => void;
  /** @param taskMap - Project task slim map for inline chip resolution. */
  taskMap: TaskSlimMap;
}

/**
 * Center pane, the editor column. Renders the empty state without a
 * selection, otherwise the note header, editable title, and the live
 * block editor as a flush document column filling the pane, with a
 * hairline divider under the header masthead. The column caps at 760px
 * with side padding that narrows below `sm` so phone widths never
 * overflow horizontally.
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
  taskMap,
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
          taskMap={taskMap}
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
  onSelectNote: (noteId: string | null) => void;
  taskMap: TaskSlimMap;
}

/** Shared pill chip classes for the header row. */
const PILL_CLASS =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase";

/**
 * Loaded-note body: header chip row (with live presence avatars on team
 * notes), editable H1 title, meta line with save status (priority
 * saving > conflict > save failed), the conflict banner when a
 * `stale_write` flush surfaced one, feed banner, and the live block
 * editor. Mounted only with
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
  taskMap,
}: EditorBodyProps) {
  const qc = useQueryClient();
  const { data, isPlaceholderData, isError } = useNoteDetail(projectId, noteId);
  const noteList = useQuery({
    queryKey: noteKeys.list(projectId),
    queryFn: fetchNotesTree(qc, projectId),
  });
  const autosave = useNoteAutosave(projectId, noteId);
  const session = useSession();
  const note = data?.note;
  const updaterName =
    note === undefined || note.updatedBy === null
      ? null
      : note.updatedBy === session.data?.user.id
        ? "you"
        : (data?.updatedByName ?? null);
  useNotePresenceHeartbeat(
    noteId,
    note !== undefined && !isPlaceholderData && note.visibility === "team",
  );
  const [title, setTitle] = useState<string | null>(null);
  const [seenServerTitle, setSeenServerTitle] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (
    note !== undefined &&
    note.title !== seenServerTitle &&
    shouldAdoptServerTitle({ dirty, focused })
  ) {
    setSeenServerTitle(note.title);
    setTitle(note.title);
  }

  const ready = note !== undefined;
  useEffect(() => {
    if (!shouldFocusTitle || !ready) return;
    const input = inputRef.current;
    if (input) {
      input.focus({ preventScroll: true });
      input.select();
    }
    onFocusedTitle();
  }, [shouldFocusTitle, ready, onFocusedTitle]);

  const commitRef = useRef<() => void>(() => {});
  useEffect(() => {
    commitRef.current = () => {
      if (note === undefined || title === null) return;
      if (
        shouldCommitTitle({
          dirty,
          localTitle: title,
          serverTitle: note.title,
          locked: note.locked,
        })
      ) {
        autosave.commit({ title });
        void autosave.flush();
        setDirty(false);
        return;
      }
      if (
        shouldClearDirty({ dirty, localTitle: title, serverTitle: note.title })
      )
        setDirty(false);
    };
  });
  useEffect(() => () => commitRef.current(), []);

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
    for (const row of noteList.data ?? []) {
      const key = row.title.trim().toLowerCase();
      if (key !== "" && !map.has(key)) {
        map.set(key, { id: row.id, title: row.title, type: row.type });
      }
    }
    return map;
  }, [noteList.data]);

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
    <div className="mx-auto max-w-[760px] px-4 pb-16 pt-6 sm:px-[34px] sm:pt-8">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!isPlaceholderData && (
          <MonoId
            id={composeNoteRef(
              asIdentifier(projectIdentifier),
              note.sequenceNumber,
            )}
            copyable={false}
          />
        )}
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
        <div className="ml-auto flex items-center gap-2">
          {note.locked && (
            <span className="font-mono text-[10px] text-text-faint">
              locked — unlock to edit
            </span>
          )}
          <PresenceAvatars noteId={noteId} visibility={note.visibility} />
          <button
            type="button"
            onClick={() => onSelectNote(null)}
            aria-label="Close note"
            title="Close note"
            className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border-strong text-text-muted hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <IconX size={12} />
          </button>
        </div>
      </div>

      <input
        ref={inputRef}
        value={title ?? ""}
        onChange={(e) => {
          setTitle(e.target.value);
          setDirty(true);
        }}
        onFocus={() => {
          setFocused(true);
          if (!note.locked) autosave.beginEditSession();
        }}
        onBlur={() => {
          setFocused(false);
          commitRef.current();
          autosave.endEditSession();
        }}
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

      <div className="mb-6 flex flex-wrap items-center gap-1.5 border-b border-border pb-4 text-[11px] text-text-muted">
        <span>
          updated {formatRelative(note.updatedAt)}
          {updaterName !== null && (
            <>
              {" by "}
              <span className="text-text-secondary">{updaterName}</span>
            </>
          )}
        </span>
        {autosave.pending ? (
          <span className="ml-auto font-mono text-[10px] text-text-faint">
            saving…
          </span>
        ) : autosave.conflict !== null ? (
          <span
            className="ml-auto font-mono text-[10px]"
            style={{ color: "var(--color-danger)" }}
          >
            conflict · changed elsewhere
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

      {autosave.conflict !== null && (
        <ConflictBanner
          noteId={noteId}
          conflict={autosave.conflict}
          identifier={projectIdentifier}
          localTitle={title ?? note.title}
          onDiscard={() => {
            autosave.resolveConflictDrop();
            setDirty(false);
            setSeenServerTitle(null);
          }}
          onKeepMine={autosave.resolveConflictReapply}
        />
      )}

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
          <NoteEditor
            body={note.body}
            editable={editable}
            identifier={projectIdentifier}
            onCommitBody={(next) => autosave.commit({ body: next })}
            onEditingChange={(editing) => {
              if (editing) autosave.beginEditSession();
              else autosave.endEditSession();
            }}
          />
        </NoteLinkContext.Provider>
      )}
    </div>
  );
}

interface PresenceAvatarsProps {
  /** @param noteId - Open note id. */
  noteId: string;
  /** @param visibility - The note's visibility; presence renders only on team notes. */
  visibility: Visibility;
}

/** How many presence avatars render before collapsing into a `+N` chip. */
const PRESENCE_AVATAR_CAP = 3;

/**
 * Overlap-stacked avatars of the other users currently editing the note,
 * fed by the shared presence store. The caller's own presence (any tab)
 * is filtered out; renders nothing on private notes or with no remote
 * editors. Caps at {@link PRESENCE_AVATAR_CAP} avatars plus a `+N` chip.
 *
 * @param props - Note id and visibility.
 * @returns The avatar row, or null.
 */
function PresenceAvatars({ noteId, visibility }: PresenceAvatarsProps) {
  const editors = useNotePresence(noteId);
  const session = useSession();
  const ownUserId = session.data?.user.id;
  const others = editors.filter((e) => e.userId !== ownUserId);
  if (visibility !== "team" || others.length === 0) return null;
  const shown = others.slice(0, PRESENCE_AVATAR_CAP);
  const overflow = others.length - shown.length;
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((editor, i) => (
        <span
          key={editor.userId}
          role="img"
          aria-label={`${editor.name} is editing`}
          title={`${editor.name} is editing`}
          className={i > 0 ? "-ml-1.5" : ""}
        >
          <span aria-hidden="true">
            <Avatar name={editor.name} src={editor.image} size={18} ring />
          </span>
        </span>
      ))}
      {overflow > 0 && (
        <span className="ml-1 font-mono text-[10px] text-text-muted">
          +{overflow}
        </span>
      )}
    </span>
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
