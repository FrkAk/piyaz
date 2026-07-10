"use client";

import {
  ChipButton,
  ChipTrigger,
  labelFor,
} from "@/components/shared/FilterChip";
import { Dropdown } from "@/components/shared/Dropdown";
import { IconFilter, IconList, IconSort } from "@/components/shared/icons";

/** Identifier for the active sort key. */
export type SortKey = "status" | "updated" | "identifier" | "priority";

/** Identifier for the active grouping (Linear-style segmentation). */
export type GroupKey = "status" | "category" | "none";

interface FilterBarProps {
  /** Active sort key. */
  sort: SortKey;
  /** Update the sort key. */
  onSortChange: (next: SortKey) => void;
  /** Active group key. */
  group: GroupKey;
  /** Update the group key. */
  onGroupChange: (next: GroupKey) => void;
  /** Whether the filter sheet is open — drives the filter button accent. */
  filterOpen: boolean;
  /** Total active filter count, badged on the filter button. */
  filterCount: number;
  /** Toggle the filter sheet. */
  onToggleFilter: () => void;
}

/** Sort dropdown options. */
const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "updated", label: "Updated" },
  { value: "identifier", label: "ID" },
];

/** Group dropdown options. */
const GROUP_OPTIONS: ReadonlyArray<{ value: GroupKey; label: string }> = [
  { value: "status", label: "Status" },
  { value: "category", label: "Category" },
  { value: "none", label: "None" },
];

/**
 * Top filter bar above the structure list — owns the filter sheet toggle
 * and the sort/group dropdowns. New-task creation lives on each
 * `TaskGroup` (the per-status "+") so the bar stays compact regardless of
 * viewport width.
 *
 * @param props - Filter bar configuration.
 * @returns 40px-tall header row.
 */
export function FilterBar({
  sort,
  onSortChange,
  group,
  onGroupChange,
  filterOpen,
  filterCount,
  onToggleFilter,
}: FilterBarProps) {
  return (
    <div className="flex h-10 items-center gap-1 border-b border-border bg-base px-3">
      <ChipButton
        active={filterOpen}
        onClick={onToggleFilter}
        icon={<IconFilter size={11} />}
        ariaPressed={filterOpen}
      >
        Filter
        {filterCount > 0 && (
          <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/20 px-1.5 font-mono text-[9px] font-bold tabular-nums text-accent-light">
            {filterCount}
          </span>
        )}
      </ChipButton>

      <Dropdown
        value={group}
        options={GROUP_OPTIONS}
        onChange={onGroupChange}
        align="end"
        ariaLabel={`Group: ${labelFor(GROUP_OPTIONS, group)}`}
        title={`Group: ${labelFor(GROUP_OPTIONS, group)}`}
        renderTrigger={(_active, open) => (
          <ChipTrigger icon={<IconList size={11} />} open={open}>
            <span className="text-text-faint">Group</span>
            <span className="ml-1 text-text-primary">
              {labelFor(GROUP_OPTIONS, group)}
            </span>
          </ChipTrigger>
        )}
      />

      <Dropdown
        value={sort}
        options={SORT_OPTIONS}
        onChange={onSortChange}
        align="end"
        ariaLabel={`Sort: ${labelFor(SORT_OPTIONS, sort)}`}
        title={`Sort: ${labelFor(SORT_OPTIONS, sort)}`}
        renderTrigger={(_active, open) => (
          <ChipTrigger icon={<IconSort size={11} />} open={open}>
            <span className="text-text-faint">Sort</span>
            <span className="ml-1 text-text-primary">
              {labelFor(SORT_OPTIONS, sort)}
            </span>
          </ChipTrigger>
        )}
      />
    </div>
  );
}

export default FilterBar;
