"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconCheck, IconChevronDown } from "@/components/shared/icons";
import { popoverFixedStyle, usePopoverAnchor } from "@/hooks/usePopoverAnchor";

export interface DropdownOption<V extends string = string> {
  /** Option value passed to onChange. */
  value: V;
  /** Visible label. */
  label: string;
  /** Optional leading visual (status glyph, swatch, etc.). */
  leading?: React.ReactNode;
  /** Optional trailing visual (count chip, kbd, etc.). */
  trailing?: React.ReactNode;
  /** When true, the option is disabled. */
  disabled?: boolean;
}

interface DropdownProps<V extends string> {
  /** Currently selected value. */
  value: V;
  /** Available options. */
  options: ReadonlyArray<DropdownOption<V>>;
  /** Update the selected value. */
  onChange: (next: V) => void;
  /** Trigger renderer; receives the currently selected option. */
  renderTrigger: (
    option: DropdownOption<V> | undefined,
    open: boolean,
  ) => React.ReactNode;
  /** Match panel width to trigger when true; defaults to false (intrinsic). */
  matchTriggerWidth?: boolean;
  /** Panel anchor; defaults to `start` (left edge of the trigger). */
  align?: "start" | "end";
  /** Optional minimum panel width in px. */
  minWidth?: number;
  /** Optional native title for the trigger. */
  title?: string;
  /** Aria label for the trigger button. */
  ariaLabel?: string;
  /** When true, the trigger is inert and the panel cannot open. */
  disabled?: boolean;
}

/** Worst-case panel height: `max-h-[280px]` list + `py-1` chrome (~8px). */
const PANEL_MAX_HEIGHT_PX = 288;

/**
 * Anchored single-select dropdown. The trigger is fully owned by the
 * caller via `renderTrigger`, so the same primitive serves status pills,
 * filter chips, and rail rows without forcing a single appearance. The
 * panel is portalled to `document.body` and positioned with `fixed`
 * coordinates so a parent's `overflow-y-auto` (which CSS-spec-promotes
 * to `overflow: auto` on both axes) cannot clip it sideways or below.
 *
 * @param props - Dropdown configuration.
 * @returns Trigger button plus animated portalled panel.
 */
export function Dropdown<V extends string>({
  value,
  options,
  onChange,
  renderTrigger,
  matchTriggerWidth = false,
  align = "start",
  minWidth = 160,
  title,
  ariaLabel,
  disabled = false,
}: DropdownProps<V>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const { anchor, measureNow } = usePopoverAnchor({
    open,
    triggerRef,
    align,
    popoverHeight: PANEL_MAX_HEIGHT_PX,
  });

  // Click-outside + Escape close. Both the trigger and the portalled
  // panel must be exempt; the panel lives outside the trigger's DOM tree,
  // so we check both refs explicitly.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = triggerRef.current?.contains(target);
      const inPopover = popoverRef.current?.contains(target);
      if (!inTrigger && !inPopover) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Toggle handler: measure synchronously during the click so the panel
  // renders with the correct anchor on its first frame. React batches the
  // two setStates inside the same event handler, so there's no extra
  // render before paint.
  const handleToggle = useCallback(() => {
    if (disabled) return;
    setOpen((wasOpen) => {
      if (!wasOpen) measureNow();
      return !wasOpen;
    });
  }, [disabled, measureNow]);

  // The panel never renders over an inert trigger: if the control is
  // disabled while open (e.g. a sibling write goes in flight), gating on
  // `disabled` here closes it without an effect-driven setState.
  const panelOpen = open && !disabled;
  const active = options.find((o) => o.value === value);
  const flipped = anchor?.vertical === "above";

  const panelStyle: React.CSSProperties | null = anchor
    ? {
        ...popoverFixedStyle(anchor),
        width: matchTriggerWidth ? anchor.width : undefined,
        minWidth,
      }
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        className={`inline-flex outline-none ${
          disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"
        }`}
      >
        {renderTrigger(active, open)}
      </button>

      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {panelOpen && panelStyle && (
              <motion.div
                ref={popoverRef}
                id={listId}
                role="listbox"
                initial={{ opacity: 0, y: flipped ? 4 : -4, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: flipped ? 4 : -4, scale: 0.97 }}
                transition={{ duration: 0.11, ease: "easeOut" }}
                className="z-50 max-h-[280px] overflow-y-auto rounded-md border border-border-strong bg-surface-raised py-1 shadow-float"
                style={panelStyle}
              >
                {options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={option.disabled}
                      onClick={() => {
                        if (option.disabled) return;
                        onChange(option.value);
                        setOpen(false);
                      }}
                      className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                        selected
                          ? "bg-accent/10 text-accent-light"
                          : option.disabled
                            ? "text-text-faint cursor-not-allowed"
                            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      }`}
                    >
                      {option.leading && (
                        <span
                          aria-hidden="true"
                          className="inline-flex shrink-0"
                        >
                          {option.leading}
                        </span>
                      )}
                      <span className="flex-1 truncate">{option.label}</span>
                      {option.trailing}
                      {selected && (
                        <span aria-hidden="true" className="text-accent-light">
                          <IconCheck size={11} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

export { IconChevronDown };
