"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconAgent,
  IconCheck,
  IconDoc,
  IconHumansAgents,
  IconLock,
  IconPanelRight,
  IconSearch,
  IconUser,
  IconUsers,
  IconX,
} from "@/components/shared/icons";
import { CategoryPicker } from "@/components/shared/CategoryPicker";
import { MonoId } from "@/components/shared/MonoId";
import { SectionHeader } from "@/components/shared/SectionHeader";
import { TagPicker } from "@/components/shared/TagPicker";
import type {
  NoteActionFailure,
  NoteActionResult,
} from "@/lib/actions/note-errors";
import type {
  LinkedNoteSlim,
  NoteFull,
  NoteMention,
  NotePatch,
} from "@/lib/data/note";
import type { FeedMode, Visibility } from "@/lib/types";
import { NOTE_TYPE_ORDER } from "@/lib/ui/note-order";
import type { TaskSlimMap } from "./EditorPane";
import { NOTE_TYPE_META, tint } from "./note-meta";
import {
  accessLevel,
  applyAccessLevel,
  feedTargetActive,
  type AccessLevel,
} from "./settings-access";
import { NoteHistory } from "./NoteHistory";
import { NoteVersions } from "./NoteVersions";
import { useNoteDetail } from "./useNoteDetail";
import {
  useApproveShareRequest,
  useDeclineShareRequest,
  useUpdateNote,
} from "./useNoteMutations";

/** Feed mode buttons in display order, with their labels. */
const FEED_MODES: { id: FeedMode; label: string }[] = [
  { id: "none", label: "Off" },
  { id: "all", label: "All" },
  { id: "categories", label: "By category" },
  { id: "tags", label: "By tag" },
  { id: "tasks", label: "By task" },
];

/** Per-mode caption explaining the feed reach. */
const FEED_MODE_HINT: Record<FeedMode, string> = {
  none: "Agents don't know this note exists and can't fetch it.",
  all: "Mentioned in every task's agent prompt over MCP.",
  categories:
    "Mentioned in agent prompts for tasks in the selected categories.",
  tags: "Mentioned in agent prompts for tasks with the selected tags.",
  tasks: "Mentioned in the agent prompts for the selected tasks.",
};

/** The three access stops rendered by {@link AccessSlider}. */
const ACCESS_STOPS: {
  id: AccessLevel;
  label: string;
  icon: React.ReactNode;
  color: string;
  hint: string;
}[] = [
  {
    id: "open",
    label: "Open",
    icon: <IconHumansAgents size={12} />,
    color: "var(--color-glyph-planned)",
    hint: "Humans and agents can edit.",
  },
  {
    id: "agent",
    label: "Agent RO",
    icon: <IconAgent size={12} />,
    color: "var(--color-glyph-review)",
    hint: "Humans edit; agents read only.",
  },
  {
    id: "locked",
    label: "Locked",
    icon: <IconLock size={12} />,
    color: "var(--color-danger)",
    hint: "Locked. No one edits until unlocked.",
  },
];

/** Controls with their own pending and error scope. */
type ControlKey =
  | "type"
  | "visibility"
  | "share"
  | "access"
  | "category"
  | "tags"
  | "feed";

/**
 * Add a control to a pending set without mutating the original.
 * @param controls - Current set.
 * @param control - Control to add.
 * @returns Same set when already present, otherwise a new set.
 */
function addControl(
  controls: ReadonlySet<ControlKey>,
  control: ControlKey,
): ReadonlySet<ControlKey> {
  if (controls.has(control)) return controls;
  const next = new Set(controls);
  next.add(control);
  return next;
}

/**
 * Remove a control from a pending set without mutating the original.
 * @param controls - Current set.
 * @param control - Control to remove.
 * @returns Same set when absent, otherwise a new set.
 */
function removeControl(
  controls: ReadonlySet<ControlKey>,
  control: ControlKey,
): ReadonlySet<ControlKey> {
  if (!controls.has(control)) return controls;
  const next = new Set(controls);
  next.delete(control);
  return next;
}

/**
 * Drop rate-limit entries whose window has elapsed.
 * @param limits - Per-control expiry timestamps.
 * @param now - Current epoch milliseconds.
 * @returns Map without elapsed entries; the same map when none elapsed.
 */
function pruneExpired(
  limits: ReadonlyMap<ControlKey, number>,
  now: number,
): ReadonlyMap<ControlKey, number> {
  const live = [...limits].filter(([, until]) => until > now);
  return live.length === limits.size ? limits : new Map(live);
}

/**
 * A short, human-facing line for a typed action failure.
 * @param failure - The typed failure from a note action.
 * @returns One-line copy for the control's inline error slot.
 */
function failureCopy(failure: NoteActionFailure): string {
  switch (failure.code) {
    case "stale_write":
      return "changed elsewhere, value restored";
    case "rate_limited":
      return "too many changes, try again shortly";
    case "not_found":
      return "note not found";
    case "share_state":
      return "no pending request";
    case "locked":
      return "note is locked";
    case "archived":
      return "project archived";
    case "invalid_input":
      return "invalid value";
    case "unauthorized":
      return "sign in to edit";
    default:
      return "save failed";
  }
}

interface SettingsPaneProps {
  /** @param projectId - Owning project id. */
  projectId: string;
  /** @param noteId - Selected note id. */
  noteId: string;
  /** @param categories - Project category vocabulary (display case). */
  categories: string[];
  /** @param projectTags - Deduped project tag vocabulary. */
  projectTags: string[];
  /** @param taskMap - Project task slim map for the by-task feed picker. */
  taskMap: TaskSlimMap;
  /** @param onSelectNote - Select another note (linked-note navigation). */
  onSelectNote: (noteId: string | null) => void;
  /** @param onSelectTask - Open a task's detail (mention navigation). */
  onSelectTask: (taskId: string) => void;
  /** @param fill - Drawer mode: full width, no left border, close button. */
  fill?: boolean;
  /** @param onCollapse - Collapse the ribbon at `lg` (column mode only). */
  onCollapse?: () => void;
  /** @param onClose - Close the drawer (fill mode only). */
  onClose?: () => void;
}

/**
 * The right settings ribbon: the note's identity (type, visibility, agent
 * access), classification (category, tags), auto-feed targeting, and a
 * read-only References block (mentions, linked notes). Reads the selected
 * note from the shared `noteKeys.detail` cache (never refetches); every
 * control writes through the optimistic note mutations, so values update
 * instantly and only the touched control shows its in-flight state. A
 * locked note disables every write control except the access slider's
 * unlock path.
 *
 * @param props - Project scope, selection, vocabularies, and chrome wiring.
 * @returns The settings ribbon column (or drawer body in `fill` mode).
 */
export function SettingsPane({
  projectId,
  noteId,
  categories,
  projectTags,
  taskMap,
  onSelectNote,
  onSelectTask,
  fill = false,
  onCollapse,
  onClose,
}: SettingsPaneProps) {
  const { data, isPlaceholderData, isError } = useNoteDetail(projectId, noteId);
  const updateNote = useUpdateNote(projectId);
  const approveShare = useApproveShareRequest(projectId);
  const declineShare = useDeclineShareRequest(projectId);

  const [pending, setPending] = useState<ReadonlySet<ControlKey>>(
    () => new Set(),
  );
  const [error, setError] = useState<{
    control: ControlKey;
    message: string;
  } | null>(null);
  const [rateLimited, setRateLimited] = useState<
    ReadonlyMap<ControlKey, number>
  >(() => new Map());

  useEffect(() => {
    if (rateLimited.size === 0) return;
    const soonest = Math.min(...rateLimited.values());
    const timer = window.setTimeout(
      () => setRateLimited((m) => pruneExpired(m, Date.now())),
      Math.max(0, soonest - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [rateLimited]);

  const run = useCallback(
    async <T,>(
      control: ControlKey,
      action: () => Promise<NoteActionResult<T>>,
    ): Promise<void> => {
      setPending((p) => addControl(p, control));
      setError((e) => (e?.control === control ? null : e));
      let result: NoteActionResult<T> | null = null;
      try {
        result = await action();
      } catch (err) {
        console.error("note settings write failed", err);
        result = null;
      }
      setPending((p) => removeControl(p, control));
      if (result === null) {
        setError({ control, message: "save failed" });
        return;
      }
      if (!result.ok) {
        if (result.code === "rate_limited") {
          const until = Date.now() + result.retryAfter * 1000;
          setRateLimited((m) => new Map(m).set(control, until));
        }
        setError({ control, message: failureCopy(result) });
        return;
      }
      setError((e) => (e?.control === control ? null : e));
    },
    [],
  );

  const note = data?.note;

  if (data === undefined || note === undefined) {
    return (
      <RibbonShell fill={fill} onCollapse={onCollapse} onClose={onClose}>
        {isError ? (
          <div className="p-4 text-[12px] text-text-muted">Note not found</div>
        ) : (
          <RibbonSkeleton />
        )}
      </RibbonShell>
    );
  }

  const meta = NOTE_TYPE_META[note.type];
  const level = accessLevel(note);
  const visibility = note.visibility;
  const loading = isPlaceholderData;
  // Write controls are blocked while the placeholder detail is live (its CAS
  // token is stale) and while the note is locked, except the access slider,
  // whose unlock path must stay reachable on a locked note. In-flight writes
  // do not block: values are optimistic and the per-note write chain
  // serializes the server calls.
  const writeBlocked = loading || note.locked;
  const accessBlocked = loading || rateLimited.has("access");

  const isRate = (control: ControlKey) => rateLimited.has(control);
  const dimmed = (control: ControlKey) => (pending.has(control) ? 0.7 : 1);

  const patch = (control: ControlKey, fields: NotePatch) =>
    void run(control, () =>
      updateNote.mutateAsync({ noteId, patch: fields, rollbackOnStale: true }),
    );

  return (
    <RibbonShell fill={fill} onCollapse={onCollapse} onClose={onClose}>
      <div className="p-4">
        <div className="mb-5">
          <FieldLabel>Type</FieldLabel>
          <div
            className="mb-3 grid grid-cols-3 gap-1.5"
            style={{ opacity: dimmed("type") }}
          >
            {NOTE_TYPE_ORDER.map((t) => {
              const m = NOTE_TYPE_META[t];
              const active = note.type === t;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={writeBlocked || isRate("type")}
                  aria-pressed={active}
                  onClick={() => {
                    if (t !== note.type) patch("type", { type: t });
                  }}
                  title={m.blurb}
                  className="flex items-center justify-center rounded-md py-1.5 font-mono text-[10px] uppercase transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
                  style={{
                    color: m.color,
                    background: active ? tint(m.color, 13) : "transparent",
                    border: `1px solid ${active ? tint(m.color, 36) : "var(--color-border)"}`,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          <p className="mb-1 text-[11px] leading-snug text-text-muted">
            {meta.blurb} {meta.rule}
          </p>
          <ControlError control="type" error={error} pending={pending} />

          <FieldLabel className="mt-3">Visibility</FieldLabel>
          <div
            className="mb-2 grid grid-cols-2 gap-1.5"
            style={{ opacity: dimmed("visibility") }}
          >
            {(["private", "team"] as Visibility[]).map((v) => {
              const active = visibility === v;
              const color =
                v === "team" ? "var(--color-done)" : "var(--color-text-muted)";
              return (
                <button
                  key={v}
                  type="button"
                  disabled={writeBlocked || isRate("visibility")}
                  aria-pressed={active}
                  onClick={() => {
                    if (v !== note.visibility) {
                      patch("visibility", { visibility: v });
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
                  style={{
                    color: active ? color : "var(--color-text-muted)",
                    background: active ? tint(color, 12) : "transparent",
                    border: `1px solid ${active ? tint(color, 34) : "var(--color-border)"}`,
                  }}
                >
                  {v === "team" ? (
                    <IconUsers size={12} />
                  ) : (
                    <IconUser size={12} />
                  )}
                  {v === "team" ? "Team" : "Private"}
                </button>
              );
            })}
          </div>
          <ControlError control="visibility" error={error} pending={pending} />

          {note.shareRequestedBy !== null && note.visibility === "private" && (
            <div
              className="mb-3 mt-1 rounded-lg p-2.5"
              style={{
                background: tint("var(--color-accent)", 8),
                border: `1px solid ${tint("var(--color-accent)", 34)}`,
                opacity: dimmed("share"),
              }}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
                <IconAgent
                  size={12}
                  style={{ color: "var(--color-accent-light)" }}
                />
                An agent asked to share this with the team.
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={writeBlocked || isRate("share")}
                  onClick={() =>
                    void run("share", () => approveShare.mutateAsync(noteId))
                  }
                  className="rounded-md px-2.5 py-1 text-[11px] font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
                  style={{ background: "var(--color-accent-fill)" }}
                >
                  {pending.has("share") ? "Sharing…" : "Approve"}
                </button>
                <button
                  type="button"
                  disabled={writeBlocked || isRate("share")}
                  onClick={() =>
                    void run("share", () => declineShare.mutateAsync(noteId))
                  }
                  className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
                >
                  Keep private
                </button>
              </div>
              <ControlError control="share" error={error} pending={pending} />
            </div>
          )}

          <FieldLabel className="mt-3">Access</FieldLabel>
          <AccessSlider
            level={level}
            disabled={accessBlocked}
            pending={pending.has("access")}
            onChange={(next) => {
              if (next === accessLevel(note)) return;
              patch("access", applyAccessLevel(next));
            }}
          />
          <ControlError control="access" error={error} pending={pending} />
        </div>

        <Section label="Classification">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            What this note is. Shares the project&rsquo;s categories and tags.
          </p>
          <FieldLabel>Category</FieldLabel>
          <div className="mb-1" style={{ opacity: dimmed("category") }}>
            <CategoryPicker
              category={note.category}
              categories={categories}
              onChange={(next) => patch("category", { category: next })}
              disabled={writeBlocked || isRate("category")}
              emptyFallback={
                <p className="text-[11px] text-text-faint">
                  No categories in this project yet.
                </p>
              }
            />
          </div>
          <ControlError control="category" error={error} pending={pending} />

          <FieldLabel className="mt-3">Tags</FieldLabel>
          <div style={{ opacity: dimmed("tags") }}>
            <TagPicker
              tags={note.tags}
              vocabulary={projectTags}
              onChange={(next) => patch("tags", { tags: next })}
              align="start"
              disabled={writeBlocked || isRate("tags")}
            />
          </div>
          <ControlError control="tags" error={error} pending={pending} />
        </Section>

        <Section label="Auto-feed into tasks">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            Controls whether agents can see this note. Off hides it entirely.
            Any other option mentions it in the agent&rsquo;s MCP prompt for the
            chosen scope.
          </p>
          <div style={{ opacity: dimmed("feed") }}>
            <FeedEditor
              note={note}
              categories={categories}
              projectTags={projectTags}
              taskMap={taskMap}
              disabled={writeBlocked || isRate("feed")}
              onSetMode={(mode) => patch("feed", { feedMode: mode })}
              onSetCategories={(next) =>
                patch("feed", { feedCategories: next })
              }
              onSetTags={(next) => patch("feed", { feedTags: next })}
              onSetTaskIds={(next) => patch("feed", { feedTaskIds: next })}
            />
          </div>
          <ControlError control="feed" error={error} pending={pending} />
        </Section>

        <div className="mt-6 border-t border-border pt-4">
          <SectionHeader label="References" />
          <p className="mb-3 text-[11px] leading-snug text-text-muted">
            Read-only. Derived from the note body, not settings.
          </p>

          <FieldLabel>Mentions</FieldLabel>
          <p className="mb-1.5 text-[11px] leading-snug text-text-muted">
            Tasks referenced in the body. Backlinks, not targeting.
          </p>
          {data.mentions.length === 0 ? (
            loading ? (
              <RefSkeleton />
            ) : (
              <div className="py-0.5 text-[12px] text-text-faint">None</div>
            )
          ) : (
            data.mentions.map((mention) => (
              <MentionRow
                key={mention.taskId}
                mention={mention}
                onSelect={onSelectTask}
              />
            ))
          )}

          <FieldLabel className="mt-4">Linked notes</FieldLabel>
          {data.linksOut.length === 0 && data.linksIn.length === 0 ? (
            loading ? (
              <RefSkeleton />
            ) : (
              <div className="py-0.5 text-[12px] text-text-faint">None</div>
            )
          ) : (
            <>
              {data.linksOut.map((linked) => (
                <LinkedNoteRow
                  key={`out-${linked.id}`}
                  note={linked}
                  direction="out"
                  onSelect={onSelectNote}
                />
              ))}
              {data.linksIn.map((linked) => (
                <LinkedNoteRow
                  key={`in-${linked.id}`}
                  note={linked}
                  direction="in"
                  onSelect={onSelectNote}
                />
              ))}
            </>
          )}
        </div>

        <NoteVersions
          projectId={projectId}
          noteId={noteId}
          locked={note.locked}
          loading={loading}
          currentVersion={note.version}
          currentTitle={note.title}
          currentUpdatedAt={note.updatedAt}
        />
        <NoteHistory projectId={projectId} noteId={noteId} />
      </div>
    </RibbonShell>
  );
}

/**
 * Skeleton body shown while the first detail fetch is in flight, following
 * the shared `skeleton-bar` convention.
 *
 * @returns Placeholder rows shaped like the ribbon sections.
 */
function RibbonSkeleton() {
  return (
    <div className="space-y-4 p-4" role="status" aria-label="Loading settings">
      <span className="skeleton-bar block h-3 w-16" />
      <span className="skeleton-bar block h-8 w-full" />
      <span
        className="skeleton-bar block h-8 w-full"
        style={{ "--skeleton-delay": "70ms" } as React.CSSProperties}
      />
      <span className="skeleton-bar block h-3 w-24" />
      <span
        className="skeleton-bar block h-6 w-2/3"
        style={{ "--skeleton-delay": "140ms" } as React.CSSProperties}
      />
      <span className="skeleton-bar block h-3 w-20" />
      <span
        className="skeleton-bar block h-6 w-full"
        style={{ "--skeleton-delay": "210ms" } as React.CSSProperties}
      />
    </div>
  );
}

/**
 * One-line reference placeholder shown while the note detail is still the
 * tree-row placeholder, so an unresolved list never asserts "None".
 *
 * @returns A single skeleton bar shaped like a reference row.
 */
function RefSkeleton() {
  return (
    <span
      className="skeleton-bar my-0.5 block h-4 w-2/3"
      role="status"
      aria-label="Loading references"
    />
  );
}

interface RibbonShellProps {
  fill: boolean;
  onCollapse?: () => void;
  onClose?: () => void;
  children: React.ReactNode;
}

/**
 * Ribbon frame: a slim toolbar with the collapse (column) or close (drawer)
 * affordance over a scrollable body. At `lg` the column is a fixed 352px
 * rail with a left border; in `fill` (drawer) mode it stretches full width.
 *
 * @param props - Chrome mode and body.
 * @returns The framed, scrollable ribbon.
 */
function RibbonShell({
  fill,
  onCollapse,
  onClose,
  children,
}: RibbonShellProps) {
  return (
    <div
      className={`flex h-full min-h-0 flex-col ${fill ? "w-full" : "w-[352px] border-l border-border"}`}
      style={{ background: "var(--color-base)" }}
    >
      <div
        className="flex shrink-0 items-center justify-between border-b border-border px-3"
        style={{ height: 36 }}
      >
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-faint">
          Settings
        </span>
        {fill ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <IconX size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide settings"
            title="Hide settings"
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <IconPanelRight size={13} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

interface ControlErrorProps {
  control: ControlKey;
  error: { control: ControlKey; message: string } | null;
  pending: ReadonlySet<ControlKey>;
}

/**
 * Inline error line for one control, mirroring the editor's `save failed`
 * slot. Hidden while the same control is mid-write so a retry does not
 * flash the stale failure.
 *
 * @param props - The control key, current error, and in-flight controls.
 * @returns The danger-toned error line, or null.
 */
function ControlError({ control, error, pending }: ControlErrorProps) {
  if (error?.control !== control || pending.has(control)) return null;
  return (
    <p
      role="status"
      className="mt-1 font-mono text-[10px]"
      style={{ color: "var(--color-danger)" }}
    >
      {error.message}
    </p>
  );
}

interface AccessSliderProps {
  level: AccessLevel;
  disabled: boolean;
  pending: boolean;
  onChange: (level: AccessLevel) => void;
}

/**
 * Three-stop access slider (Open, Agent read-only, Locked) as an ARIA
 * radiogroup with roving tabindex and Arrow-key traversal. The thumb slides
 * to the active stop and takes its color; the whole group dims while a write
 * is in flight but stays interactive on a locked note so the unlock path is
 * reachable.
 *
 * @param props - Active level, disabled/pending flags, and the change handler.
 * @returns The radiogroup slider.
 */
function AccessSlider({
  level,
  disabled,
  pending,
  onChange,
}: AccessSliderProps) {
  const idx = ACCESS_STOPS.findIndex((s) => s.id === level);
  const active = ACCESS_STOPS[Math.max(0, idx)];
  const refs = useRef<Map<AccessLevel, HTMLButtonElement>>(new Map());

  const move = (delta: number) => {
    const next =
      ACCESS_STOPS[(idx + delta + ACCESS_STOPS.length) % ACCESS_STOPS.length];
    refs.current.get(next.id)?.focus();
    onChange(next.id);
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Access"
        className="relative mb-2 flex rounded-full p-0.5"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          opacity: disabled ? 0.55 : pending ? 0.7 : 1,
        }}
      >
        <span
          aria-hidden="true"
          className="absolute rounded-full transition-transform"
          style={{
            top: 2,
            bottom: 2,
            left: 2,
            width: "calc((100% - 4px) / 3)",
            transform: `translateX(${Math.max(0, idx) * 100}%)`,
            background: tint(active.color, 18),
            border: `1px solid ${tint(active.color, 40)}`,
          }}
        />
        {ACCESS_STOPS.map((s) => {
          const on = s.id === level;
          return (
            <button
              key={s.id}
              ref={(el) => {
                if (el) refs.current.set(s.id, el);
                else refs.current.delete(s.id);
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={s.label}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(s.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(-1);
                }
              }}
              className="relative z-10 flex flex-1 items-center justify-center gap-1 rounded-full py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed enabled:cursor-pointer"
              style={{ color: on ? s.color : "var(--color-text-muted)" }}
            >
              {s.icon}
              {s.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-text-muted">{active.hint}</p>
    </div>
  );
}

interface FeedEditorProps {
  note: NoteFull;
  categories: string[];
  projectTags: string[];
  taskMap: TaskSlimMap;
  disabled: boolean;
  onSetMode: (mode: FeedMode) => void;
  onSetCategories: (next: string[]) => void;
  onSetTags: (next: string[]) => void;
  onSetTaskIds: (next: string[]) => void;
}

/**
 * Auto-feed editor: the mode selector plus the matching target picker
 * (category / tag chips or status-colored task rows) and the per-mode hint.
 * Feed targets are stored canonicalized to lowercase, so category and tag
 * membership is compared case-insensitively against the display-case
 * project vocabulary.
 *
 * @param props - The note, project vocabularies, disabled flag, and setters.
 * @returns The mode row, the active picker, and the hint caption.
 */
function FeedEditor({
  note,
  categories,
  projectTags,
  taskMap,
  disabled,
  onSetMode,
  onSetCategories,
  onSetTags,
  onSetTaskIds,
}: FeedEditorProps) {
  const toggleTarget = (
    stored: string[],
    option: string,
    commit: (next: string[]) => void,
  ) => {
    if (feedTargetActive(stored, option)) {
      const needle = option.trim().toLowerCase();
      commit(stored.filter((v) => v.toLowerCase() !== needle));
    } else {
      commit([...stored, option]);
    }
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Feed mode"
        className="mb-2 flex flex-wrap gap-1.5"
      >
        {FEED_MODES.map((m) => {
          const active = note.feedMode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              role="radio"
              aria-checked={active}
              onClick={() => {
                if (m.id !== note.feedMode) onSetMode(m.id);
              }}
              className="rounded-full px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
              style={{
                color: active ? "#fff" : "var(--color-text-muted)",
                fontWeight: active ? 500 : 400,
                background: active ? "var(--color-accent-fill)" : "transparent",
                border: `1px solid ${active ? "var(--color-accent-fill)" : "var(--color-border)"}`,
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {note.feedMode === "categories" &&
        (categories.length === 0 ? (
          <p className="text-[11px] text-text-faint">
            No categories in this project yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <ChipToggle
                key={c}
                label={c}
                active={feedTargetActive(note.feedCategories, c)}
                disabled={disabled}
                onClick={() =>
                  toggleTarget(note.feedCategories, c, onSetCategories)
                }
              />
            ))}
          </div>
        ))}

      {note.feedMode === "tags" &&
        (projectTags.length === 0 ? (
          <p className="text-[11px] text-text-faint">
            No tags in this project yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {projectTags.map((t) => (
              <ChipToggle
                key={t}
                label={t}
                active={feedTargetActive(note.feedTags, t)}
                disabled={disabled}
                onClick={() => toggleTarget(note.feedTags, t, onSetTags)}
              />
            ))}
          </div>
        ))}

      {note.feedMode === "tasks" &&
        (taskMap.size === 0 ? (
          <p className="text-[11px] text-text-faint">
            No tasks in this project yet.
          </p>
        ) : (
          <FeedTaskPicker
            taskMap={taskMap}
            selectedIds={note.feedTaskIds}
            disabled={disabled}
            onChange={onSetTaskIds}
          />
        ))}

      <p className="mt-2 text-[11px] leading-snug text-text-muted">
        {FEED_MODE_HINT[note.feedMode]}
      </p>
    </div>
  );
}

/** Result rows shown per query in the feed task search. */
const FEED_TASK_RESULT_CAP = 20;

interface FeedTaskPickerProps {
  /** Project task slim map (the already-loaded graph). */
  taskMap: TaskSlimMap;
  /** Selected feed task ids. */
  selectedIds: string[];
  /** When true, rows are inert. */
  disabled: boolean;
  /** Replace the selected id list. */
  onChange: (next: string[]) => void;
}

/**
 * Searchable by-task feed picker. Selected tasks are always listed;
 * matches for the current query (title or ref, over the already-loaded
 * task map, capped) appear below them, so a large project never renders
 * its whole task list. The search input drives the row list as an ARIA
 * combobox: ArrowUp/ArrowDown move the highlight (wrapping), Enter
 * toggles the highlighted row, Escape clears the query.
 *
 * @param props - Task map, selection, disabled flag, and the setter.
 * @returns The search input plus the bounded row list.
 */
function FeedTaskPicker({
  taskMap,
  selectedIds,
  disabled,
  onChange,
}: FeedTaskPickerProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const needle = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!needle) return [];
    const hits: string[] = [];
    for (const [taskId, task] of taskMap) {
      if (selectedSet.has(taskId)) continue;
      if (
        task.title.toLowerCase().includes(needle) ||
        task.taskRef.toLowerCase().includes(needle)
      ) {
        hits.push(taskId);
        if (hits.length >= FEED_TASK_RESULT_CAP) break;
      }
    }
    return hits;
  }, [needle, selectedSet, taskMap]);

  const rowIds = useMemo(
    () => [...selectedIds, ...results],
    [selectedIds, results],
  );
  const highlightedId =
    highlightIdx >= 0 && highlightIdx < rowIds.length
      ? rowIds[highlightIdx]
      : undefined;

  const toggle = (taskId: string) => {
    onChange(
      selectedSet.has(taskId)
        ? selectedIds.filter((id) => id !== taskId)
        : [...selectedIds, taskId],
    );
  };

  const moveHighlight = (delta: number) => {
    if (rowIds.length === 0) return;
    const next =
      highlightIdx === -1
        ? delta > 0
          ? 0
          : rowIds.length - 1
        : (highlightIdx + delta + rowIds.length) % rowIds.length;
    setHighlightIdx(next);
    const target = rowIds[next];
    if (target !== undefined) {
      listRef.current
        ?.querySelector(`[data-task-id="${target}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedId !== undefined) toggle(highlightedId);
    } else if (e.key === "Escape" && query !== "") {
      e.stopPropagation();
      setQuery("");
      setHighlightIdx(-1);
    }
  };

  const row = (taskId: string, active: boolean) => {
    const task = taskMap.get(taskId);
    if (!task) return null;
    const highlighted = taskId === highlightedId;
    return (
      <button
        key={taskId}
        id={`${listId}-${taskId}`}
        data-task-id={taskId}
        type="button"
        role="option"
        disabled={disabled}
        aria-selected={active}
        onClick={() => toggle(taskId)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
        style={{
          background: highlighted
            ? "var(--color-surface-hover)"
            : active
              ? tint("var(--color-accent)", 8)
              : "transparent",
          boxShadow: highlighted
            ? `inset 0 0 0 1px ${tint("var(--color-accent)", 55)}`
            : undefined,
        }}
      >
        <MonoId
          id={task.taskRef}
          copyable={false}
          tone={task.status as never}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
          {task.title}
        </span>
        {active && (
          <span
            className="font-mono text-[9px] uppercase"
            style={{ color: "var(--color-accent-light)" }}
          >
            fed
          </span>
        )}
      </button>
    );
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-border px-2 py-1 focus-within:border-accent/40 focus-within:ring-1 focus-within:ring-accent/40">
        <IconSearch size={11} className="shrink-0 text-text-faint" />
        <input
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightIdx(
              e.target.value.trim() === "" ? -1 : selectedIds.length,
            );
          }}
          onKeyDown={onSearchKeyDown}
          role="combobox"
          aria-expanded={rowIds.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            highlightedId !== undefined
              ? `${listId}-${highlightedId}`
              : undefined
          }
          aria-label="Search tasks to feed"
          placeholder="Search tasks by title or ref…"
          className="w-full bg-transparent text-[11px] outline-none placeholder:text-text-faint disabled:cursor-not-allowed"
          style={{ color: "var(--color-text-secondary)" }}
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Feed tasks"
        aria-multiselectable="true"
        className="flex max-h-[240px] flex-col gap-1 overflow-y-auto"
      >
        {selectedIds.map((taskId) => row(taskId, true))}
        {results.map((taskId) => row(taskId, false))}
      </div>
      {selectedIds.length === 0 && !needle && (
        <p className="mt-1 text-[11px] text-text-faint">
          No tasks selected. Search above to add some.
        </p>
      )}
      {needle && results.length === 0 && (
        <p className="mt-1 text-[11px] text-text-faint">No matching tasks.</p>
      )}
    </div>
  );
}

interface ChipToggleProps {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}

/**
 * Selectable accent chip for a category or tag feed target. A selected
 * target carries a check glyph and accent fill so it reads as a checked
 * filter, distinct from the solid single-choice mode pills above it.
 *
 * @param props - Label, active/disabled state, and the toggle handler.
 * @returns The pill toggle button.
 */
function ChipToggle({ label, active, disabled, onClick }: ChipToggleProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
      style={{
        color: active ? "var(--color-accent-light)" : "var(--color-text-muted)",
        background: active ? tint("var(--color-accent)", 16) : "transparent",
        border: `1px solid ${active ? tint("var(--color-accent)", 45) : "var(--color-border)"}`,
      }}
    >
      {active && <IconCheck size={9} aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

interface MentionRowProps {
  mention: NoteMention;
  onSelect: (taskId: string) => void;
}

/**
 * One mention row: the referenced task's status-colored ref and title.
 * Clicking opens the task's detail.
 *
 * @param props - The mention to render and the task-select handler.
 * @returns The mention button row.
 */
function MentionRow({ mention, onSelect }: MentionRowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mention.taskId)}
      title={`Open ${mention.taskRef}`}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
    >
      <MonoId id={mention.taskRef} copyable={false} tone={mention.status} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
        {mention.title}
      </span>
    </button>
  );
}

interface LinkedNoteRowProps {
  note: LinkedNoteSlim;
  direction: "in" | "out";
  onSelect: (noteId: string) => void;
}

/**
 * One linked-note row: the note type glyph, its title, and the link
 * direction. Clicking selects the note in place.
 *
 * @param props - The linked note, its direction, and the select handler.
 * @returns The linked-note button row.
 */
function LinkedNoteRow({ note, direction, onSelect }: LinkedNoteRowProps) {
  const color = NOTE_TYPE_META[note.type].color;
  return (
    <button
      type="button"
      onClick={() => onSelect(note.id)}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
    >
      <IconDoc size={13} style={{ color }} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
        {note.title}
      </span>
      <span className="font-mono text-[9.5px] text-text-faint">
        {direction}
      </span>
    </button>
  );
}

interface SectionProps {
  label: string;
  children: React.ReactNode;
}

/**
 * A ribbon section with a mono uppercase header rule.
 *
 * @param props - Section label and body.
 * @returns The labelled section wrapper.
 */
function Section({ label, children }: SectionProps) {
  return (
    <div className="mb-5">
      <div className="section-label">{label}</div>
      {children}
    </div>
  );
}

interface FieldLabelProps {
  className?: string;
  children: React.ReactNode;
}

/**
 * A compact mono uppercase field label.
 *
 * @param props - Optional extra classes and the label text.
 * @returns The field label.
 */
function FieldLabel({ className = "", children }: FieldLabelProps) {
  return (
    <div
      className={`mb-1 font-mono text-[10px] uppercase tracking-wider text-text-faint ${className}`}
    >
      {children}
    </div>
  );
}

export default SettingsPane;
