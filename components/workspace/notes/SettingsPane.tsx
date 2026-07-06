"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAgent,
  IconDoc,
  IconLock,
  IconPanelRight,
  IconTag,
  IconUser,
  IconUsers,
  IconX,
} from "@/components/shared/icons";
import { ChipTrigger } from "@/components/shared/FilterChip";
import { Dropdown } from "@/components/shared/Dropdown";
import { MonoId } from "@/components/shared/MonoId";
import type {
  NoteActionFailure,
  NoteActionResult,
} from "@/lib/actions/note-errors";
import type { LinkedNoteSlim, NoteFull, NoteMention } from "@/lib/data/note";
import type { FeedMode, Visibility } from "@/lib/types";
import type { TaskSlimMap } from "./EditorPane";
import { NOTE_TYPE_META, tint } from "./note-meta";
import {
  accessLevel,
  applyAccessLevel,
  feedTargetActive,
  type AccessLevel,
} from "./settings-access";
import { useNoteDetail } from "./useNoteDetail";
import {
  useApproveShareRequest,
  useDeclineShareRequest,
  useSetNoteAccess,
  useSetNoteVisibility,
  useUpdateNote,
} from "./useNoteMutations";

/** The note types offered in the Type group, in display order. */
const TYPE_ORDER = ["reference", "guidance", "knowledge"] as const;

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
    icon: <IconUsers size={12} />,
    color: "var(--color-done)",
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
    hint: "Locked — no one edits until unlocked.",
  },
];

/** Which control most recently issued a mutation; scopes pending + errors. */
type ControlKey =
  | "type"
  | "visibility"
  | "share"
  | "access"
  | "category"
  | "tags"
  | "feed";

/** A short, human-facing line for a typed action failure. */
function failureCopy(failure: NoteActionFailure): string {
  switch (failure.code) {
    case "stale_write":
      return "changed elsewhere — reopen to retry";
    case "rate_limited":
      return "too many changes — try again shortly";
    case "not_found":
      return "note not found";
    case "share_state":
      return "no pending request";
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
  /** @param fill - Drawer mode: full width, no left border, close button. */
  fill?: boolean;
  /** @param onCollapse - Collapse the ribbon at `lg` (column mode only). */
  onCollapse?: () => void;
  /** @param onClose - Close the drawer (fill mode only). */
  onClose?: () => void;
}

/**
 * The right settings ribbon: the note's identity (type, visibility, agent
 * access), classification (category, tags), auto-feed targeting, and the
 * derived mentions and linked notes. Reads the selected note from the
 * shared `noteKeys.detail` cache (never refetches) and turns the editor's
 * display-only header pills into live write controls wired to the note
 * mutation hooks. Every write shows a per-control pending state and rolls
 * back with a visible error on failure; a locked note disables every write
 * control except the access slider's unlock path.
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
  fill = false,
  onCollapse,
  onClose,
}: SettingsPaneProps) {
  const { data, isPlaceholderData, isError } = useNoteDetail(projectId, noteId);
  const updateNote = useUpdateNote(projectId);
  const setAccess = useSetNoteAccess(projectId);
  const setVisibility = useSetNoteVisibility(projectId);
  const approveShare = useApproveShareRequest(projectId);
  const declineShare = useDeclineShareRequest(projectId);

  const [pending, setPending] = useState<ControlKey | null>(null);
  const [error, setError] = useState<{
    control: ControlKey;
    message: string;
  } | null>(null);
  const [rateLimited, setRateLimited] = useState<{
    control: ControlKey;
    until: number;
  } | null>(null);
  const [pendingAccess, setPendingAccess] = useState<AccessLevel | null>(null);
  const [pendingVisibility, setPendingVisibility] = useState<Visibility | null>(
    null,
  );

  useEffect(() => {
    if (rateLimited === null) return;
    const remaining = Math.max(0, rateLimited.until - Date.now());
    const timer = window.setTimeout(() => setRateLimited(null), remaining);
    return () => window.clearTimeout(timer);
  }, [rateLimited]);

  const run = useCallback(
    async <T,>(
      control: ControlKey,
      action: () => Promise<NoteActionResult<T>>,
      onRevert?: () => void,
    ): Promise<void> => {
      setPending(control);
      setError((e) => (e?.control === control ? null : e));
      let result: NoteActionResult<T> | null = null;
      try {
        result = await action();
      } catch {
        result = null;
      }
      setPending((p) => (p === control ? null : p));
      if (result === null) {
        onRevert?.();
        setError({ control, message: "save failed" });
        return;
      }
      if (!result.ok) {
        onRevert?.();
        if (result.code === "rate_limited") {
          setRateLimited({
            control,
            until: Date.now() + result.retryAfter * 1000,
          });
        }
        setError({ control, message: failureCopy(result) });
        return;
      }
      setError((e) => (e?.control === control ? null : e));
    },
    [],
  );

  const note = data?.note;

  // Hold the optimistic access/visibility value until the refetched detail
  // reflects it. On success the one-shot hooks fold only the slim summary
  // into the detail cache, which omits the settings columns, so those land on
  // the finalizeSettingsWrite refetch. Clearing the pending on mutation-settle
  // would flash the thumb/segment back to the stale value for one round-trip;
  // reconciling here (React re-renders in place) defers to the note only once
  // it catches up and never overrides a later external change. Failures revert
  // the pending through run's onRevert.
  if (note && pendingAccess !== null && accessLevel(note) === pendingAccess) {
    setPendingAccess(null);
  }
  if (
    note &&
    pendingVisibility !== null &&
    note.visibility === pendingVisibility
  ) {
    setPendingVisibility(null);
  }

  if (data === undefined || note === undefined) {
    return (
      <RibbonShell fill={fill} onCollapse={onCollapse} onClose={onClose}>
        <div className="p-4 text-[12px] text-text-muted">
          {isError ? "Note not found" : "Loading…"}
        </div>
      </RibbonShell>
    );
  }

  const meta = NOTE_TYPE_META[note.type];
  const level = pendingAccess ?? accessLevel(note);
  const visibility = pendingVisibility ?? note.visibility;
  const busy = pending !== null;
  const loading = isPlaceholderData;
  // Write controls are blocked while the placeholder detail is live (its CAS
  // token is stale), while another control's write is in flight, and while
  // the note is locked — except the access slider, whose unlock path must
  // stay reachable on a locked note.
  const writeBlocked = loading || busy || note.locked;
  // The access slider stays focusable while its own write is in flight (a
  // hard `disabled` would drop keyboard focus mid-commit); a concurrent write
  // is instead rejected in the change handler via `busy`. It only hard-
  // disables while the placeholder is live or the control is rate-limited.
  const accessBlocked = loading || rateLimited?.control === "access";

  const isRate = (control: ControlKey) => rateLimited?.control === control;

  const patch = (
    control: ControlKey,
    fields: Parameters<typeof updateNote.mutateAsync>[0]["patch"],
  ) =>
    void run(control, () => updateNote.mutateAsync({ noteId, patch: fields }));

  return (
    <RibbonShell fill={fill} onCollapse={onCollapse} onClose={onClose}>
      <div className="p-4">
        <Section label="Settings">
          <FieldLabel>Type</FieldLabel>
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {TYPE_ORDER.map((t) => {
              const m = NOTE_TYPE_META[t];
              const active = note.type === t;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={writeBlocked || isRate("type")}
                  aria-pressed={active}
                  onClick={() => patch("type", { type: t })}
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
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            {(["private", "team"] as Visibility[]).map((v) => {
              const active = visibility === v;
              const color =
                v === "team" ? "var(--color-done)" : "var(--color-accent)";
              return (
                <button
                  key={v}
                  type="button"
                  disabled={writeBlocked || isRate("visibility")}
                  aria-pressed={active}
                  onClick={() => {
                    if (v === note.visibility) return;
                    setPendingVisibility(v);
                    void run(
                      "visibility",
                      () =>
                        setVisibility.mutateAsync({ noteId, visibility: v }),
                      () => setPendingVisibility(null),
                    );
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
                  onClick={() => {
                    setPendingVisibility("team");
                    void run(
                      "share",
                      () => approveShare.mutateAsync(noteId),
                      () => setPendingVisibility(null),
                    );
                  }}
                  className="rounded-md px-2.5 py-1 text-[11px] font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
                  style={{ background: "var(--color-accent)" }}
                >
                  {pending === "share" ? "Sharing…" : "Approve"}
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
            pending={pending === "access"}
            onChange={(next) => {
              if (busy || next === accessLevel(note)) return;
              setPendingAccess(next);
              void run(
                "access",
                () =>
                  setAccess.mutateAsync({
                    noteId,
                    access: applyAccessLevel(next),
                  }),
                () => setPendingAccess(null),
              );
            }}
          />
          <ControlError control="access" error={error} pending={pending} />
        </Section>

        <Section label="Classification">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            What this note is. Shares the project&rsquo;s categories and tags.
          </p>
          <FieldLabel>Category</FieldLabel>
          <div className="mb-1">
            <Dropdown
              value={note.category ?? ""}
              options={[
                { value: "", label: "Uncategorized" },
                ...categories.map((c) => ({ value: c, label: c })),
              ]}
              onChange={(v) =>
                patch("category", { category: v === "" ? null : v })
              }
              disabled={writeBlocked || isRate("category")}
              ariaLabel="Category"
              renderTrigger={(opt, open) => (
                <ChipTrigger icon={<IconTag size={11} />} open={open}>
                  {opt?.label ?? "Uncategorized"}
                </ChipTrigger>
              )}
            />
          </div>
          <ControlError control="category" error={error} pending={pending} />

          <FieldLabel className="mt-3">Tags</FieldLabel>
          <TagEditor
            tags={note.tags}
            disabled={writeBlocked || isRate("tags")}
            onAdd={(t) => patch("tags", { tags: [...note.tags, t] })}
            onRemove={(t) =>
              patch("tags", { tags: note.tags.filter((x) => x !== t) })
            }
          />
          <ControlError control="tags" error={error} pending={pending} />
        </Section>

        <Section label="Auto-feed into tasks">
          <p className="mb-2 text-[11px] leading-snug text-text-muted">
            Controls whether agents can see this note. Off hides it entirely.
            Any other option mentions it in the agent&rsquo;s MCP prompt for the
            chosen scope.
          </p>
          <FeedEditor
            note={note}
            categories={categories}
            projectTags={projectTags}
            taskMap={taskMap}
            disabled={writeBlocked || isRate("feed")}
            onSetMode={(mode) => patch("feed", { feedMode: mode })}
            onSetCategories={(next) => patch("feed", { feedCategories: next })}
            onSetTags={(next) => patch("feed", { feedTags: next })}
            onSetTaskIds={(next) => patch("feed", { feedTaskIds: next })}
          />
          <ControlError control="feed" error={error} pending={pending} />
        </Section>

        <Section label="Mentions">
          <p className="mb-1.5 text-[11px] leading-snug text-text-muted">
            Tasks referenced in the body — backlinks, not targeting.
          </p>
          {data.mentions.length === 0 ? (
            <div className="py-0.5 text-[12px] text-text-faint">None</div>
          ) : (
            data.mentions.map((mention) => (
              <MentionRow key={mention.taskId} mention={mention} />
            ))
          )}
        </Section>

        <Section label="Linked notes">
          {data.linksOut.length === 0 && data.linksIn.length === 0 ? (
            <div className="py-0.5 text-[12px] text-text-faint">None</div>
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
        </Section>
      </div>
    </RibbonShell>
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
 * affordance over a scrollable body. At `lg` the column is a fixed 320px
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
      className={`flex min-h-0 flex-col ${fill ? "h-full w-full" : "w-[320px] shrink-0 border-l border-border"}`}
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
  pending: ControlKey | null;
}

/**
 * Inline error line for one control, mirroring the editor's `save failed`
 * slot. Hidden while the same control is mid-write so a retry does not
 * flash the stale failure.
 *
 * @param props - The control key, current error, and in-flight control.
 * @returns The danger-toned error line, or null.
 */
function ControlError({ control, error, pending }: ControlErrorProps) {
  if (error?.control !== control || pending === control) return null;
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
 * Three-stop access slider — Open, Agent read-only, Locked — as an ARIA
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
          opacity: pending ? 0.7 : 1,
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

interface TagEditorProps {
  tags: string[];
  disabled: boolean;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}

/**
 * Tag chips with an inline add input — Enter commits the trimmed lowercase
 * value, the X removes a chip. Duplicate or empty commits are dropped.
 *
 * @param props - Current tags, disabled flag, and add/remove handlers.
 * @returns The wrapping chip row with its input.
 */
function TagEditor({ tags, disabled, onAdd, onRemove }: TagEditorProps) {
  const [val, setVal] = useState("");

  const commit = () => {
    const t = val.trim().toLowerCase();
    if (t && !tags.includes(t)) onAdd(t);
    setVal("");
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      style={{ opacity: disabled ? 0.55 : 1 }}
    >
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
          style={{
            color: "var(--color-accent-light)",
            background: tint("var(--color-accent)", 12),
            border: `1px solid ${tint("var(--color-accent)", 26)}`,
          }}
        >
          <span className="truncate">{t}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(t)}
            aria-label={`Remove ${t}`}
            className="shrink-0 text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed enabled:cursor-pointer"
          >
            <IconX size={10} />
          </button>
        </span>
      ))}
      <input
        value={val}
        disabled={disabled}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        aria-label="Add tag"
        placeholder="add tag…"
        className="min-w-[64px] flex-1 bg-transparent text-[11px] outline-none placeholder:text-text-faint disabled:cursor-not-allowed"
        style={{ color: "var(--color-text-secondary)" }}
      />
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
 * Auto-feed editor — the mode selector plus the matching target picker
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
      <div className="mb-2 flex flex-wrap gap-1.5">
        {FEED_MODES.map((m) => {
          const active = note.feedMode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => {
                if (m.id !== note.feedMode) onSetMode(m.id);
              }}
              className="rounded-full px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
              style={{
                color: active
                  ? "var(--color-accent-light)"
                  : "var(--color-text-muted)",
                background: active
                  ? tint("var(--color-accent)", 13)
                  : "transparent",
                border: `1px solid ${active ? tint("var(--color-accent)", 32) : "var(--color-border)"}`,
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
          <div className="flex flex-col gap-1">
            {[...taskMap.entries()].map(([taskId, task]) => {
              const active = note.feedTaskIds.includes(taskId);
              return (
                <button
                  key={taskId}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => {
                    const next = active
                      ? note.feedTaskIds.filter((id) => id !== taskId)
                      : [...note.feedTaskIds, taskId];
                    onSetTaskIds(next);
                  }}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
                  style={{
                    background: active
                      ? tint("var(--color-accent)", 8)
                      : "transparent",
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
            })}
          </div>
        ))}

      <p className="mt-2 text-[11px] leading-snug text-text-muted">
        {FEED_MODE_HINT[note.feedMode]}
      </p>
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
 * Selectable accent chip for a category or tag feed target.
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
      className="max-w-full truncate rounded-full px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 enabled:cursor-pointer"
      style={{
        color: active ? "var(--color-accent-light)" : "var(--color-text-muted)",
        background: active ? tint("var(--color-accent)", 13) : "transparent",
        border: `1px solid ${active ? tint("var(--color-accent)", 30) : "var(--color-border)"}`,
      }}
    >
      {label}
    </button>
  );
}

interface MentionRowProps {
  mention: NoteMention;
}

/**
 * One mention row: the referenced task's status-colored ref and title.
 *
 * @param props - The mention to render.
 * @returns The mention row.
 */
function MentionRow({ mention }: MentionRowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <MonoId id={mention.taskRef} copyable={false} tone={mention.status} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-secondary">
        {mention.title}
      </span>
    </div>
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
