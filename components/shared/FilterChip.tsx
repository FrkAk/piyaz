"use client";

import { IconChevronDown } from "@/components/shared/icons";

interface ChipButtonProps {
  /** Active state — drives accent fill. */
  active?: boolean;
  /** Click handler. */
  onClick: () => void;
  /** Leading icon. */
  icon: React.ReactNode;
  /** Native title for tooltip. */
  title?: string;
  /** Aria-pressed state. */
  ariaPressed?: boolean;
  /** Chip body. */
  children: React.ReactNode;
}

/**
 * Small chip-style action used by filter triggers — taller hover surface
 * and tighter padding than the generic ghost Button so the row reads as a
 * tool group, not a stack of unrelated CTAs.
 *
 * @param props - Chip configuration.
 * @returns Inline button with leading icon.
 */
export function ChipButton({
  active = false,
  onClick,
  icon,
  title,
  ariaPressed,
  children,
}: ChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed}
      className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 text-[12px] font-medium transition-colors ${
        active
          ? "border-accent/30 bg-accent/10 text-accent-light"
          : "border-transparent text-text-secondary hover:border-border-strong hover:bg-surface-hover"
      }`}
    >
      <span
        aria-hidden="true"
        className={active ? "text-accent-light" : "text-text-faint"}
      >
        {icon}
      </span>
      {children}
    </button>
  );
}

interface ChipTriggerProps {
  /** Leading icon. */
  icon: React.ReactNode;
  /** Whether the parent dropdown is open — drives chevron rotation. */
  open: boolean;
  /** Trigger body. */
  children: React.ReactNode;
}

/**
 * Visual mirror of {@link ChipButton} for use inside a `<Dropdown>` trigger
 * render prop — adds a chevron that rotates on open.
 *
 * @param props - Trigger configuration.
 * @returns Inline span styled like a chip.
 */
export function ChipTrigger({ icon, open, children }: ChipTriggerProps) {
  return (
    <span className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:bg-surface-hover">
      <span aria-hidden="true" className="text-text-faint">
        {icon}
      </span>
      {children}
      <span
        aria-hidden="true"
        className="text-text-faint transition-transform"
        style={{ transform: open ? "rotate(180deg)" : "none" }}
      >
        <IconChevronDown size={9} />
      </span>
    </span>
  );
}
