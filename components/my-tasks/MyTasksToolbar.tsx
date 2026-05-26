"use client";

import { forwardRef } from "react";
import {
  IconFilter,
  IconList,
} from "@/components/shared/icons";
import { SearchInput } from "./SearchInput";

interface MyTasksToolbarProps {
  /** Number of active filter chips (view + status + search). Hides the badge at 0. */
  filterCount: number;
  /** Current search query. */
  query: string;
  /** Search query handler. */
  onQueryChange: (next: string) => void;
}

/**
 * 2-row toolbar wrapped in a bordered container. Top row carries the
 * Filter count chip and a static `Group · Status` indicator; the bottom
 * row hosts the search input. Sort is intentionally absent in v1 — server
 * orders by `updatedAt DESC` and the saved-view tabs provide the only
 * filter dimension the design exercises.
 *
 * @param props - Filter count + search query + handler.
 * @param ref - Forwarded search input ref, focused on `/` from the parent.
 * @returns Bordered toolbar element.
 */
export const MyTasksToolbar = forwardRef<HTMLInputElement, MyTasksToolbarProps>(
  function MyTasksToolbar({ filterCount, query, onQueryChange }, ref) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
        <div className="flex h-[38px] items-center gap-1 border-b border-border px-2">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-[12px] font-medium text-text-secondary">
            <span aria-hidden="true" className="text-text-faint">
              <IconFilter size={11} />
            </span>
            Filter
            {filterCount > 0 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/20 px-1.5 font-mono text-[9px] font-bold tabular-nums text-accent-light">
                {filterCount}
              </span>
            )}
          </span>
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-[12px] font-medium text-text-secondary">
            <span aria-hidden="true" className="text-text-faint">
              <IconList size={11} />
            </span>
            <span>Group:</span>
            <span className="text-text-primary">Status</span>
          </span>
        </div>
        <SearchInput ref={ref} value={query} onChange={onQueryChange} />
      </div>
    );
  },
);
