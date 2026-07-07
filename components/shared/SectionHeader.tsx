import type { ReactNode } from "react";

interface SectionHeaderProps {
  /** Mono uppercase label rendered on the left. */
  label: string;
  /** Optional mono count rendered next to the label. */
  count?: ReactNode;
  /** Optional badge rendered before the trailing slot. */
  badge?: ReactNode;
  /** Optional trailing slot (CopyButton, Undo, etc). */
  trailing?: ReactNode;
}

/**
 * Reusable section header: mono uppercase label plus an optional count,
 * badge, and trailing affordance, with a hairline rule that fills the
 * remaining width.
 *
 * @param props - Header configuration.
 * @returns Header row above a section body.
 */
export function SectionHeader({
  label,
  count,
  badge,
  trailing,
}: SectionHeaderProps) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}
      </span>
      {count != null && (
        <span className="font-mono text-[10px] tabular-nums text-text-faint">
          {count}
        </span>
      )}
      {badge}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {trailing}
    </div>
  );
}

export default SectionHeader;
