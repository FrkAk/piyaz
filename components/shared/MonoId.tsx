"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

/**
 * Visual tone for the identifier — uses the same vocabulary as
 * {@link StatusGlyph}'s status names plus a `default` neutral. Each tone
 * maps to a `--color-glyph-*` CSS var so the task-ref reads in the same
 * colour as the matching glyph (and, in lists, the matching group header).
 */
export type MonoIdTone =
  | "default"
  | "draft"
  | "plannable"
  | "planned"
  | "ready"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

interface MonoIdProps {
  /** @param id - Identifier to render and copy (e.g. `MYMR-104`). */
  id: string;
  /** @param dim - Use the fainter muted color (used for de-emphasised list rows). */
  dim?: boolean;
  /**
   * @param tone - Encode derived task state in the resting color so plannable
   *   and ready rows are scannable in the list without separate pill chips.
   *   Defaults to `default` (existing behaviour). Ignored when `dim` is set.
   */
  tone?: MonoIdTone;
  /** @param copyable - Click-to-copy. Defaults to true. */
  copyable?: boolean;
  /** @param className - Additional CSS classes. */
  className?: string;
  /**
   * @param hintOnMount - Briefly swap the id text for "Copy" when it first
   *   renders so operators discover the affordance. Re-fires whenever `id`
   *   changes. Off by default.
   */
  hintOnMount?: boolean;
}

/**
 * Resolve the resting color for the identifier text. `dim` overrides
 * everything (kept for done / cancelled list rows); otherwise the tone
 * lands on the matching `--color-glyph-*` token so the ref shares the
 * colour of its status glyph and group header.
 *
 * `draft` falls through to `--color-text-secondary` because the actual
 * `--color-glyph-draft` is alpha-faded (≈45%) — readable as a 12-pixel
 * dashed ring, but too washed-out for body text.
 *
 * @param dim - Force the muted color regardless of tone.
 * @param tone - Lifecycle stage tone.
 * @returns CSS color value referencing a token.
 */
function toneColor(dim: boolean, tone: MonoIdTone): string {
  if (dim) return "var(--color-text-muted)";
  switch (tone) {
    case "plannable":
    case "planned":
      return "var(--color-glyph-planned)";
    case "ready":
    case "in_progress":
      return "var(--color-glyph-progress)";
    case "in_review":
      return "var(--color-glyph-review)";
    case "blocked":
      return "var(--color-glyph-blocked)";
    case "done":
      return "var(--color-glyph-done)";
    case "cancelled":
      return "var(--color-glyph-cancelled)";
    case "draft":
    case "default":
    default:
      return "var(--color-text-secondary)";
  }
}

/** How long the auto-mount hint stays visible. */
const MOUNT_HINT_DURATION_MS = 1400;
/** Delay before the auto-mount hint appears so it doesn't compete with the panel transition. */
const MOUNT_HINT_DELAY_MS = 200;

/**
 * Mono-styled task identifier (e.g. `MYMR-104`). Click-to-copy by default.
 * When `hintOnMount` is set, the id text briefly cross-fades to "Copy" on
 * mount and to "Copied" on a successful copy so the affordance is obvious
 * without adding chrome around the row.
 *
 * @param props - MonoId configuration.
 * @returns A button (when copyable) or span rendering the identifier in mono.
 */
export function MonoId({
  id,
  dim = false,
  tone = "default",
  copyable = true,
  className = "",
  hintOnMount = false,
}: MonoIdProps) {
  const { status, copy } = useCopyToClipboard();
  const [showMountHint, setShowMountHint] = useState(false);
  const [prevId, setPrevId] = useState(id);

  if (id !== prevId) {
    setPrevId(id);
    setShowMountHint(false);
  }

  useEffect(() => {
    if (!hintOnMount || !copyable) return;
    const showTimer = window.setTimeout(
      () => setShowMountHint(true),
      MOUNT_HINT_DELAY_MS,
    );
    const hideTimer = window.setTimeout(
      () => setShowMountHint(false),
      MOUNT_HINT_DELAY_MS + MOUNT_HINT_DURATION_MS,
    );
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, [hintOnMount, copyable, id]);

  const baseClass = `font-mono tabular-nums select-none ${className}`;
  const baseStyle = {
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.02em",
    transition: "color 120ms ease",
  } as const;

  if (!copyable) {
    return (
      <span
        className={baseClass}
        style={{ ...baseStyle, color: toneColor(dim, tone) }}
      >
        {id}
      </span>
    );
  }

  const view: "copied" | "hint" | "id" =
    status === "copied" ? "copied" : showMountHint ? "hint" : "id";
  const label = view === "copied" ? "Copied" : view === "hint" ? "Copy" : id;
  const color =
    view === "copied" || view === "hint"
      ? "var(--color-accent-light)"
      : toneColor(dim, tone);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setShowMountHint(false);
        void copy(id);
      }}
      className={`${baseClass} relative inline-block cursor-pointer overflow-hidden whitespace-nowrap hover:text-text-primary`}
      style={{ ...baseStyle, color }}
      aria-label={status === "copied" ? `${id} copied` : `Copy ${id}`}
      title={status === "copied" ? "Copied!" : "Click to copy"}
    >
      {/* Invisible sizer keeps the button width stable across label swaps. */}
      <span aria-hidden="true" className="invisible">
        {id}
      </span>

      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={view}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="absolute inset-0 text-left"
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

export default MonoId;
