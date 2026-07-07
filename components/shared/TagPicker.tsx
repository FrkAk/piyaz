"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconPlus, IconX } from "@/components/shared/icons";
import { popoverFixedStyle, usePopoverAnchor } from "@/hooks/usePopoverAnchor";

/** Worst-case popover height: search box plus the capped checklist. */
const PANEL_MAX_HEIGHT_PX = 264;

interface TagPickerProps {
  /** Tags currently attached. */
  tags: string[];
  /** Project tag vocabulary. */
  vocabulary: string[];
  /** Replace the tag list. */
  onChange: (next: string[]) => void;
  /** Panel anchor side. Defaults to `end`. */
  align?: "start" | "end";
  /** When true, chips lose their remove affordance and the trigger is inert. */
  disabled?: boolean;
}

/**
 * Multi-select tag editor. Current tags render as removable chips, and a
 * trailing "+ Add" trigger opens a portalled popover combining a search
 * input with a checklist of the vocabulary; a query with no exact match
 * can be created via Enter or the footer row.
 *
 * @param props - Editor configuration.
 * @returns Wrap of chips plus the add control.
 */
export function TagPicker({
  tags,
  vocabulary,
  onChange,
  align = "end",
  disabled = false,
}: TagPickerProps) {
  const tagSet = useMemo(() => new Set(tags), [tags]);

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const toggleTag = (tag: string) => {
    if (tagSet.has(tag)) onChange(tags.filter((t) => t !== tag));
    else onChange([...tags, tag]);
  };

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tagSet.has(trimmed)) return;
    onChange([...tags, trimmed]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="group inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 py-px pl-2 pr-1 font-mono text-[11px] text-accent-light"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
              className="cursor-pointer rounded p-0.5 text-accent-light/70 transition-colors hover:bg-accent/15 hover:text-accent-light"
            >
              <IconX size={9} />
            </button>
          )}
        </span>
      ))}
      <TagAdd
        vocabulary={vocabulary}
        active={tagSet}
        onToggle={toggleTag}
        onCreate={addTag}
        align={align}
        disabled={disabled}
      />
    </div>
  );
}

interface TagAddProps {
  /** Project tag vocabulary. */
  vocabulary: string[];
  /** Tags currently attached. */
  active: Set<string>;
  /** Toggle a tag on/off. */
  onToggle: (tag: string) => void;
  /** Create a new tag (also attaches it). */
  onCreate: (tag: string) => void;
  /** Panel anchor side. */
  align: "start" | "end";
  /** When true, the trigger is inert. */
  disabled: boolean;
}

/**
 * "+ Add" trigger owning the portalled search-and-checklist popover.
 * Portalling plus fixed anchoring keeps the panel clear of ancestor
 * `overflow-y-auto` clipping and flips above the trigger when the
 * viewport runs out of room below.
 *
 * @param props - Add control configuration.
 * @returns Trigger button plus animated portalled panel.
 */
function TagAdd({
  vocabulary,
  active,
  onToggle,
  onCreate,
  align,
  disabled,
}: TagAddProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { anchor, measureNow } = usePopoverAnchor({
    open,
    triggerRef,
    align,
    popoverHeight: PANEL_MAX_HEIGHT_PX,
  });

  // Close resets the search box at the call site so the next open starts
  // clean without a setState-in-effect.
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = triggerRef.current?.contains(target);
      const inPopover = popoverRef.current?.contains(target);
      if (!inTrigger && !inPopover) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escape);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escape);
      window.clearTimeout(focusTimer);
    };
  }, [open, close]);

  const q = query.trim().toLowerCase();
  const sorted = useMemo(
    () => [...vocabulary].sort((a, b) => a.localeCompare(b)),
    [vocabulary],
  );
  const filtered = q
    ? sorted.filter((t) => t.toLowerCase().includes(q))
    : sorted;
  const exact = q && sorted.some((t) => t.toLowerCase() === q);
  const canCreate = q && !exact;

  const panelOpen = open && !disabled;
  const flipped = anchor?.vertical === "above";
  const panelStyle = anchor ? popoverFixedStyle(anchor) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          measureNow();
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong px-1.5 py-px font-mono text-[10px] text-text-muted transition-colors ${
          disabled
            ? "cursor-not-allowed opacity-55"
            : "cursor-pointer hover:border-border-stronger hover:bg-surface-hover hover:text-text-secondary"
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <IconPlus size={9} />
        Add
      </button>

      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {panelOpen && panelStyle && (
              <motion.div
                ref={popoverRef}
                role="listbox"
                initial={{ opacity: 0, y: flipped ? 4 : -4, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: flipped ? 4 : -4, scale: 0.97 }}
                transition={{ duration: 0.11, ease: "easeOut" }}
                className="z-50 w-[200px] overflow-hidden rounded-md border border-border-strong bg-surface-raised shadow-float"
                style={panelStyle}
              >
                <div className="border-b border-border bg-base p-1.5">
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canCreate) {
                        onCreate(query);
                        setQuery("");
                      }
                    }}
                    placeholder={
                      vocabulary.length > 0
                        ? "Search or create tag…"
                        : "Create a tag…"
                    }
                    className="w-full bg-transparent px-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted/50 outline-none"
                  />
                </div>
                <div className="max-h-[220px] overflow-y-auto py-1">
                  {filtered.length === 0 && !canCreate && (
                    <p className="px-2.5 py-1.5 font-mono text-[11px] italic text-text-muted">
                      No tags yet. Type to create one.
                    </p>
                  )}
                  {filtered.map((tag) => {
                    const on = active.has(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        role="option"
                        aria-selected={on}
                        onClick={() => onToggle(tag)}
                        className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors ${
                          on
                            ? "bg-accent/10 text-accent-light"
                            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border"
                          style={{
                            background: on
                              ? "var(--color-accent-grad)"
                              : "transparent",
                            borderColor: on
                              ? "transparent"
                              : "var(--color-border-strong)",
                          }}
                        >
                          {on && (
                            <svg
                              width="8"
                              height="8"
                              viewBox="0 0 16 16"
                              aria-hidden="true"
                            >
                              <path
                                d="M3 8.5L6.5 12 13 5"
                                stroke="var(--color-base)"
                                strokeWidth="2"
                                fill="none"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                        <span className="flex-1 truncate">{tag}</span>
                      </button>
                    );
                  })}
                  {canCreate && (
                    <button
                      type="button"
                      onClick={() => {
                        onCreate(query);
                        setQuery("");
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 border-t border-border px-2.5 py-1.5 text-left font-mono text-[11px] text-accent-light transition-colors hover:bg-accent/10"
                    >
                      <IconPlus size={10} />
                      <span>Create &ldquo;{query.trim()}&rdquo;</span>
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
