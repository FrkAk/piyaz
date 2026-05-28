"use client";

import { IconChevronDown } from "@/components/shared/icons";

interface ChipButtonProps {
  active?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title?: string;
  ariaPressed?: boolean;
  children: React.ReactNode;
}

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
  icon: React.ReactNode;
  open: boolean;
  children: React.ReactNode;
}

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
