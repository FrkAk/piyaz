"use client";

import { useMemo, type ReactNode } from "react";
import { CategoryDot } from "@/components/shared/CategoryDot";
import { Dropdown, type DropdownOption } from "@/components/shared/Dropdown";
import { IconChevronDown } from "@/components/shared/icons";

/** Sentinel modeling the "clear" action under the string option schema. */
const SENTINEL_CLEAR = "__clear__";

interface CategoryPickerProps {
  /** Active category, or null when unset. */
  category: string | null;
  /** Project category vocabulary. */
  categories: string[];
  /** Update the category; null clears it. */
  onChange: (next: string | null) => void;
  /** Panel anchor side. Defaults to `start`. */
  align?: "start" | "end";
  /** Rendered instead of the picker when no categories exist and none is set. */
  emptyFallback?: ReactNode;
  /** When true, the trigger is inert. */
  disabled?: boolean;
}

/**
 * Single-select category picker. Chip-styled trigger anchoring a portalled
 * list of project categories with their hue dots plus an "Uncategorized"
 * clear entry.
 *
 * @param props - Picker configuration.
 * @returns Anchored dropdown element, or the empty fallback.
 */
export function CategoryPicker({
  category,
  categories,
  onChange,
  align = "start",
  emptyFallback,
  disabled = false,
}: CategoryPickerProps) {
  const options = useMemo(() => {
    const items: DropdownOption[] = [
      { value: SENTINEL_CLEAR, label: "Uncategorized" },
    ];
    for (const cat of categories) {
      items.push({
        value: cat,
        label: cat,
        leading: <CategoryDot name={cat} />,
      });
    }
    return items;
  }, [categories]);

  if (categories.length === 0 && !category) {
    return <>{emptyFallback ?? null}</>;
  }

  return (
    <Dropdown
      value={category ?? SENTINEL_CLEAR}
      options={options}
      onChange={(v) => onChange(v === SENTINEL_CLEAR ? null : v)}
      align={align}
      ariaLabel="Change category"
      title="Change category"
      minWidth={180}
      disabled={disabled}
      renderTrigger={(_active, open) => (
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] font-medium transition-colors ${
            category
              ? "bg-accent/10 text-accent-light"
              : "border border-dashed border-border-strong text-text-muted/70"
          }`}
        >
          {category && <CategoryDot name={category} />}
          {category ?? "Uncategorized"}
          <span
            aria-hidden="true"
            className="opacity-70 transition-transform"
            style={{ transform: open ? "rotate(180deg)" : "none" }}
          >
            <IconChevronDown size={9} />
          </span>
        </span>
      )}
    />
  );
}
