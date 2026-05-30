"use client";

import { IconX } from "@/components/shared/icons";

export interface ActiveFilterChip {
  id: string;
  key: string;
  value: string;
  tone: string | null;
}

interface ActiveFiltersProps {
  chips: ActiveFilterChip[];
  onClear: (id: string) => void;
  onClearAll: () => void;
}

export function ActiveFilters({
  chips,
  onClear,
  onClearAll,
}: ActiveFiltersProps) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-3">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.10em] text-text-faint">
        Filtered by
      </span>
      {chips.map((chip) => {
        const baseStyle: React.CSSProperties = chip.tone
          ? {
              backgroundColor: `color-mix(in srgb, ${chip.tone} 12%, transparent)`,
              borderColor: `color-mix(in srgb, ${chip.tone} 24%, transparent)`,
              color: chip.tone,
            }
          : {
              backgroundColor: "var(--color-surface-raised)",
              borderColor: "var(--color-border)",
              color: "var(--color-text-secondary)",
            };
        return (
          <span
            key={chip.id}
            className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md border px-2 font-mono text-[10.5px] tabular-nums"
            style={baseStyle}
          >
            <span className="uppercase tracking-[0.08em] opacity-70">
              {chip.key}
            </span>
            <span aria-hidden="true" className="opacity-70">
              ·
            </span>
            <span>{chip.value}</span>
            <button
              type="button"
              onClick={() => onClear(chip.id)}
              aria-label={`Clear ${chip.key.toLowerCase()} filter`}
              className="ml-0.5 inline-flex h-3 w-3 cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              <IconX size={9} />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={onClearAll}
        className="ml-auto cursor-pointer border-none bg-transparent font-mono text-[10.5px] uppercase tracking-[0.08em] text-text-muted transition-colors hover:text-text-primary"
      >
        Clear all
      </button>
    </div>
  );
}
