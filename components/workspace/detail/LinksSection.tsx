"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { useUndo, UndoButton } from "@/hooks/useUndo";
import {
  addTaskLink,
  removeTaskLink,
  updateTaskLink,
} from "@/lib/graph/mutations";
import { classifyLink } from "@/lib/links/classify";
import { IconPencil, IconPlus, IconTrash } from "@/components/shared/icons";
import type { IconProps } from "@/components/shared/icons";
import {
  IconFigma,
  IconGitHub,
  IconGitLab,
  IconGlobe,
  IconGoogle,
  IconLinear,
  IconNotion,
  IconReddit,
  IconStackOverflow,
} from "@/components/shared/host-icons";
import type { TaskLinkRef } from "@/lib/data/views";
import { SectionHeader } from "@/components/shared/SectionHeader";

/**
 * Host -> glyph map. Hosts in the classifier's recognised set get their own
 * mark; everything else falls back to the globe.
 */
const HOST_ICONS: Record<string, ComponentType<IconProps>> = {
  "github.com": IconGitHub,
  "www.github.com": IconGitHub,
  "gitlab.com": IconGitLab,
  "www.gitlab.com": IconGitLab,
  "linear.app": IconLinear,
  "notion.so": IconNotion,
  "www.notion.so": IconNotion,
  "figma.com": IconFigma,
  "www.figma.com": IconFigma,
  "google.com": IconGoogle,
  "www.google.com": IconGoogle,
  "docs.google.com": IconGoogle,
  "drive.google.com": IconGoogle,
  "reddit.com": IconReddit,
  "www.reddit.com": IconReddit,
  "old.reddit.com": IconReddit,
  "stackoverflow.com": IconStackOverflow,
  "www.stackoverflow.com": IconStackOverflow,
};

/**
 * Render the host glyph as a fixed-size SVG. Hosts in {@link HOST_ICONS}
 * get their own mark; everything else falls back to the globe. Returning
 * the rendered JSX (not the component) avoids React's
 * "components created during render" warning that fires when an `Icon`
 * variable is assigned inside a parent render.
 *
 * @param host - The URL's host string.
 * @param size - Pixel size to apply.
 * @returns Inline SVG element.
 */
function HostGlyph({ host, size = 14 }: { host: string; size?: number }) {
  const Icon: ComponentType<IconProps> = HOST_ICONS[host] ?? IconGlobe;
  return <Icon size={size} />;
}

/**
 * Per-kind dot color, sourced from existing DESIGN_2 §1.2 tokens.
 * Hardcoded (not hashed like {@link CategoryDot}) because link kinds are
 * a small closed set with semantic affinities — PR sits in brand indigo,
 * issue is amber ("work needed"), commit is green ("completed thing"),
 * doc is violet ("knowledge"), fallback link is neutral muted.
 */
const KIND_COLORS: Record<string, string> = {
  pull_request: "var(--color-accent)",
  issue: "var(--color-glyph-progress)",
  commit: "var(--color-glyph-done)",
  doc: "var(--color-glyph-review)",
  link: "var(--color-text-muted)",
};

/**
 * Kind affordance, modelled on {@link CategoryDot} from DESIGN_2 §3.10:
 * a 6×6 hue swatch that conveys kind at-a-glance and reclaims the
 * horizontal space the old "PULL REQUEST" chip was eating. The kind
 * label rides in the native `title` tooltip so the value stays
 * discoverable on hover without competing with the link text.
 *
 * @param kind - Link kind enum value.
 * @returns Dot element.
 */
function KindDot({ kind }: { kind: string }) {
  const color = KIND_COLORS[kind] ?? KIND_COLORS.link;
  return (
    <span
      aria-label={`kind: ${kind.replace(/_/g, " ")}`}
      title={kind.replace(/_/g, " ")}
      className="shrink-0 rounded-full"
      style={{
        width: 6,
        height: 6,
        background: color,
        boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)`,
      }}
    />
  );
}

/**
 * Extract a URL's host, falling back to an empty string when the URL is
 * unparseable. Server-side classification already validated the URL on
 * write, so this should almost never miss.
 *
 * @param url - URL string.
 * @returns Host part of the URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Stable signature for a links list — id|url pairs joined into a single
 * string. Lets the component detect prop content drift without thrashing
 * on reference identity.
 *
 * @param items - Links from props.
 * @returns Pipe-joined signature.
 */
function signatureFor(items: TaskLinkRef[] | undefined | null): string {
  return (items ?? []).map((l) => `${l.id}|${l.url}`).join("||");
}

interface LinksSectionProps {
  /** Task UUID. */
  taskId: string;
  /** Current links projection from the server. */
  links: TaskLinkRef[];
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
}

/**
 * Task links section. Lists every `task_links` row attached to this task,
 * with a kind-derived host glyph and the parsed label. Adds run through the
 * URL classifier (no kind picker — the URL alone decides). Delete surfaces
 * an undo affordance via {@link useUndo} matching the criteria/decisions
 * pattern; the same 1s SSE-suppress window absorbs the round-trip latency.
 *
 * @param props - Section configuration.
 * @returns Links list plus add affordance.
 */
export function LinksSection({
  taskId,
  links,
  onGraphChange,
}: LinksSectionProps) {
  const [local, setLocal] = useState<TaskLinkRef[]>(() => links ?? []);
  const [syncedSig, setSyncedSig] = useState(() => signatureFor(links));
  const [prevTaskId, setPrevTaskId] = useState(taskId);
  const [suppressing, setSuppressing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localRef = useRef(local);
  const suppressTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    localRef.current = local;
  }, [local]);
  useEffect(
    () => () => {
      if (suppressTimerRef.current !== null)
        window.clearTimeout(suppressTimerRef.current);
      if (errorTimerRef.current !== null)
        window.clearTimeout(errorTimerRef.current);
    },
    [],
  );

  /**
   * Mark a 1s window where SSE refreshes won't clobber the optimistic
   * local state.
   */
  const markMutation = () => {
    setSuppressing(true);
    if (suppressTimerRef.current !== null)
      window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => {
      setSuppressing(false);
      suppressTimerRef.current = null;
    }, 1000);
  };

  /**
   * Surface a transient error message that auto-clears after 3s. Used
   * for malformed URL and duplicate URL feedback.
   */
  const flashError = (message: string) => {
    setError(message);
    if (errorTimerRef.current !== null)
      window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => {
      setError(null);
      errorTimerRef.current = null;
    }, 3000);
  };

  const incomingSig = signatureFor(links);
  if (!suppressing && incomingSig !== syncedSig) {
    setSyncedSig(incomingSig);
    setLocal(links ?? []);
  }

  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId);
    setAdding(false);
    setEditingId(null);
    setError(null);
  }

  const handleRestore = useCallback(
    async (item: { url: string; index: number }) => {
      markMutation();
      try {
        const restored = await addTaskLink(taskId, item.url);
        const next = [...localRef.current];
        next.splice(item.index, 0, restored as TaskLinkRef);
        setLocal(next);
        onGraphChange?.();
      } catch {
        flashError("Could not restore link.");
      }
    },
    [taskId, onGraphChange],
  );

  const {
    canUndo,
    push: pushUndo,
    undo,
  } = useUndo<{ url: string; index: number }>({
    onUndo: handleRestore,
    resetOn: taskId,
  });

  const handleDelete = useCallback(
    async (linkId: string) => {
      const index = localRef.current.findIndex((l) => l.id === linkId);
      if (index === -1) return;
      const removed = localRef.current[index];
      setLocal(localRef.current.filter((l) => l.id !== linkId));
      pushUndo({ url: removed.url, index });
      markMutation();
      try {
        await removeTaskLink(linkId);
        onGraphChange?.();
      } catch {
        flashError("Delete failed.");
      }
    },
    [pushUndo, onGraphChange],
  );

  const handleAdd = useCallback(
    async (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) {
        setAdding(false);
        return;
      }
      // Light client-side validation so the user gets immediate feedback;
      // shares the same classifier the server runs, so scheme-less input
      // (`google.com`) and non-http schemes stay consistent across surfaces.
      try {
        classifyLink(trimmed);
      } catch {
        flashError("Invalid URL.");
        return;
      }
      setAdding(false);
      markMutation();
      try {
        const newLink = await addTaskLink(taskId, trimmed);
        const linkRef = newLink as TaskLinkRef;
        const exists = localRef.current.some((l) => l.id === linkRef.id);
        if (!exists) {
          setLocal([...localRef.current, linkRef]);
        }
        onGraphChange?.();
      } catch {
        flashError("Could not add link.");
      }
    },
    [taskId, onGraphChange],
  );

  const handleEdit = useCallback(
    async (linkId: string, url: string) => {
      const trimmed = url.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const target = localRef.current.find((l) => l.id === linkId);
      if (target && trimmed === target.url) {
        setEditingId(null);
        return;
      }
      try {
        classifyLink(trimmed);
      } catch {
        flashError("Invalid URL.");
        return;
      }
      setEditingId(null);
      markMutation();
      try {
        const updated = await updateTaskLink(linkId, trimmed);
        const next = localRef.current.map((l) =>
          l.id === linkId ? (updated as TaskLinkRef) : l,
        );
        setLocal(next);
        onGraphChange?.();
      } catch {
        flashError("Could not update link.");
      }
    },
    [onGraphChange],
  );

  return (
    <section className="mb-7">
      <SectionHeader
        label="Links"
        count={local.length > 0 ? local.length : undefined}
        trailing={
          <span className="flex items-center gap-1.5">
            <UndoButton canUndo={canUndo} onUndo={undo} />
            {!adding && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
                aria-label="Add link"
              >
                <IconPlus size={10} />
                Add
              </button>
            )}
          </span>
        }
      />

      {local.length === 0 && !adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="Attach a link"
          className="group/empty flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-surface-raised/10 px-4 py-3.5 text-text-muted transition-colors hover:border-accent/40 hover:bg-surface-raised/30 hover:text-text-secondary"
        >
          <IconPlus size={11} />
          <span className="font-mono text-[11px] tracking-wide">
            Attach a PR, issue, or doc by URL
          </span>
        </button>
      ) : (
        <div className="space-y-1.5">
          {local.map((link) => (
            <LinkCard
              key={link.id}
              link={link}
              editing={editingId === link.id}
              onStartEdit={() => setEditingId(link.id)}
              onCommitEdit={(url) => void handleEdit(link.id, url)}
              onCancelEdit={() => setEditingId(null)}
              onDelete={() => void handleDelete(link.id)}
            />
          ))}
        </div>
      )}

      {adding && (
        <LinkAddForm
          onSubmit={(url) => void handleAdd(url)}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
        />
      )}

      {error && (
        <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 font-mono text-[10px] text-danger">
          {error}
        </div>
      )}
    </section>
  );
}

interface LinkCardProps {
  /** Link projection. */
  link: TaskLinkRef;
  /** Whether this card is in edit mode. */
  editing: boolean;
  /** Switch to edit mode. */
  onStartEdit: () => void;
  /** Commit a new URL for the link. */
  onCommitEdit: (url: string) => void;
  /** Leave edit mode without committing. */
  onCancelEdit: () => void;
  /** Delete this link. */
  onDelete: () => void;
}

/**
 * Link row with kind-derived host glyph, parsed label, and a kind chip
 * that mirrors the decisions-section source chip. Anchor opens in a new
 * tab with `rel='noopener noreferrer'` per security. The pencil button
 * swaps the row into an inline edit form; the anchor itself stays a pure
 * navigation surface so single-click never accidentally enters edit mode.
 *
 * @param props - Card configuration.
 * @returns Card element.
 */
function LinkCard({
  link,
  editing,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: LinkCardProps) {
  if (editing) {
    return (
      <LinkEditForm
        initialUrl={link.url}
        onSubmit={onCommitEdit}
        onCancel={onCancelEdit}
      />
    );
  }
  const host = hostOf(link.url);
  const display = link.label ?? host ?? link.url;
  return (
    <div className="group/link flex items-center gap-2.5 rounded-md border border-border/40 bg-transparent py-1.5 pl-2.5 pr-1.5 transition-colors hover:border-border-strong hover:bg-surface-raised/40">
      <KindDot kind={link.kind} />
      <span className="shrink-0 text-text-secondary transition-colors group-hover/link:text-text-primary">
        <HostGlyph host={host} size={14} />
      </span>
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate text-[13px] text-text-primary transition-colors hover:text-accent-light"
        title={link.url}
      >
        {display}
      </a>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-text-faint opacity-0 transition-opacity group-hover/link:opacity-100 pointer-coarse:opacity-100">
        {link.kind.replace(/_/g, " ")}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/link:opacity-100 pointer-coarse:opacity-100">
        <button
          type="button"
          onClick={onStartEdit}
          aria-label="Edit link"
          className="cursor-pointer rounded p-1 text-text-muted transition-colors hover:bg-surface-hover hover:text-accent-light"
        >
          <IconPencil size={11} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete link"
          className="cursor-pointer rounded p-1 text-text-muted transition-colors hover:bg-surface-hover hover:text-danger"
        >
          <IconTrash size={11} />
        </button>
      </div>
    </div>
  );
}

interface LinkEditFormProps {
  /** Current URL value to preload into the input. */
  initialUrl: string;
  /** Commit the edited URL. */
  onSubmit: (url: string) => void;
  /** Dismiss without saving. */
  onCancel: () => void;
}

/**
 * Inline edit form for an existing link. Same visual treatment as
 * {@link LinkAddForm} so a row swaps in place without layout shift.
 * Enter commits; Escape cancels.
 *
 * @param props - Form configuration.
 * @returns Form element.
 */
function LinkEditForm({ initialUrl, onSubmit, onCancel }: LinkEditFormProps) {
  const [url, setUrl] = useState(initialUrl);

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-raised/40">
      <div className="space-y-2 p-3">
        <input
          autoFocus
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={submit}
            disabled={!url.trim()}
            className="cursor-pointer rounded-md border border-accent/30 bg-accent/15 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-light transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface LinkAddFormProps {
  /** Commit a new URL. */
  onSubmit: (url: string) => void;
  /** Dismiss without saving. */
  onCancel: () => void;
}

/**
 * Single URL input with Add / Cancel chips. Mirrors the decisions-section
 * add form's card aesthetic so the two sections share a visual rhythm.
 * Enter commits; Escape cancels.
 *
 * @param props - Form configuration.
 * @returns Form element.
 */
function LinkAddForm({ onSubmit, onCancel }: LinkAddFormProps) {
  const [url, setUrl] = useState("");

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface-raised/40">
      <div className="space-y-2 p-3">
        <input
          autoFocus
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="github.com/owner/repo/pull/1"
          className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={submit}
            disabled={!url.trim()}
            className="cursor-pointer rounded-md border border-accent/30 bg-accent/15 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-light transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default LinksSection;
