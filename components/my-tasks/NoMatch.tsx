"use client";

import { IconSearch } from "@/components/shared/icons";

interface NoMatchProps {
  onReset: () => void;
}

export function NoMatch({ onReset }: NoMatchProps) {
  return (
    <div className="mt-3.5 flex flex-col items-center justify-center gap-2.5 rounded-[10px] border border-dashed border-border-strong bg-surface/30 px-6 py-14 text-text-muted">
      <IconSearch size={20} />
      <p className="text-[13px] text-text-secondary">
        No tasks match the current filters.
      </p>
      <button
        type="button"
        onClick={onReset}
        className="inline-flex h-[26px] cursor-pointer items-center rounded-md border border-border-strong bg-surface-raised px-3 text-[12px] font-medium text-text-primary shadow-[var(--shadow-button)] transition-colors hover:bg-surface-hover"
      >
        Reset filters
      </button>
    </div>
  );
}
