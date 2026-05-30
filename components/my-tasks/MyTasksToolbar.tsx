"use client";

import { forwardRef } from "react";
import { Dropdown } from "@/components/shared/Dropdown";
import { ChipButton, ChipTrigger } from "@/components/shared/FilterChip";
import { IconFilter, IconList, IconSort } from "@/components/shared/icons";
import {
  GROUP_OPTIONS,
  SORT_OPTIONS,
  type GroupKey,
  type SortKey,
} from "./predicates";
import { SearchInput } from "./SearchInput";

interface MyTasksToolbarProps {
  filterOpen: boolean;
  onToggleFilter: () => void;
  filterCount: number;
  group: GroupKey;
  onGroupChange: (next: GroupKey) => void;
  sort: SortKey;
  onSortChange: (next: SortKey) => void;
  query: string;
  onQueryChange: (next: string) => void;
}

const SORT_LABEL: Record<SortKey, string> = {
  updated: "Updated",
  priority: "Priority",
  status: "Status",
  id: "ID",
};

const GROUP_LABEL: Record<GroupKey, string> = {
  status: "Status",
  project: "Project",
  none: "None",
};

export const MyTasksToolbar = forwardRef<HTMLInputElement, MyTasksToolbarProps>(
  function MyTasksToolbar(
    {
      filterOpen,
      onToggleFilter,
      filterCount,
      group,
      onGroupChange,
      sort,
      onSortChange,
      query,
      onQueryChange,
    },
    ref,
  ) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
        <div className="flex h-[38px] items-center gap-1 border-b border-border px-2">
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
            align="start"
            ariaLabel={`Group: ${GROUP_LABEL[group]}`}
            title={`Group: ${GROUP_LABEL[group]}`}
            renderTrigger={(_active, open) => (
              <ChipTrigger icon={<IconList size={11} />} open={open}>
                <span className="text-text-faint">Group:</span>
                <span className="text-text-primary">{GROUP_LABEL[group]}</span>
              </ChipTrigger>
            )}
          />

          <Dropdown
            value={sort}
            options={SORT_OPTIONS}
            onChange={onSortChange}
            align="start"
            ariaLabel={`Sort: ${SORT_LABEL[sort]}`}
            title={`Sort: ${SORT_LABEL[sort]}`}
            renderTrigger={(_active, open) => (
              <ChipTrigger icon={<IconSort size={11} />} open={open}>
                <span className="text-text-faint">Sort:</span>
                <span className="text-text-primary">{SORT_LABEL[sort]}</span>
              </ChipTrigger>
            )}
          />
        </div>
        <SearchInput ref={ref} value={query} onChange={onQueryChange} />
      </div>
    );
  },
);
