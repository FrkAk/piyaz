'use client';

import { ViewTabs } from '@/components/shared/ViewTabs';
import { Dropdown } from '@/components/shared/Dropdown';
import {
  IconChevronDown,
  IconFilter,
  IconGraph,
  IconList,
  IconSort,
} from '@/components/shared/icons';

/** Identifier for the active workspace view. */
export type WorkspaceView = 'structure' | 'graph';

/** Identifier for the active sort key. */
export type SortKey = 'status' | 'updated' | 'identifier' | 'priority';

/** Identifier for the active grouping (Linear-style segmentation). */
export type GroupKey = 'status' | 'category' | 'none';

interface FilterBarProps {
  /** Active view tab. */
  view: WorkspaceView;
  /** Switch view tabs. */
  onViewChange: (next: WorkspaceView) => void;
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
  { value: 'status',     label: 'Status' },
  { value: 'priority',   label: 'Priority' },
  { value: 'updated',    label: 'Updated' },
  { value: 'identifier', label: 'ID' },
];

/** Group dropdown options. */
const GROUP_OPTIONS: ReadonlyArray<{ value: GroupKey; label: string }> = [
  { value: 'status',   label: 'Status' },
  { value: 'category', label: 'Category' },
  { value: 'none',     label: 'None' },
];

/**
 * Lookup the display label for a value in an options table.
 *
 * @param options - Option list.
 * @param value - Active value.
 * @returns Matching label or empty string.
 */
function labelFor<V extends string>(options: ReadonlyArray<{ value: V; label: string }>, value: V): string {
  return options.find((o) => o.value === value)?.label ?? '';
}

/**
 * Top filter bar above the structure list — owns view tab switching, the
 * filter sheet toggle, and the sort/group dropdowns. New-task creation
 * lives on each `TaskGroup` (the per-status "+") so the bar stays compact
 * regardless of viewport width.
 *
 * @param props - Filter bar configuration.
 * @returns 44px-tall header row.
 */
export function FilterBar({
  view,
  onViewChange,
  sort,
  onSortChange,
  group,
  onGroupChange,
  filterOpen,
  filterCount,
  onToggleFilter,
}: FilterBarProps) {
  return (
    <div className="flex h-11 items-center gap-1 border-b border-border bg-base px-3">
      <ViewTabs
        activeId={view}
        onChange={(id) => onViewChange(id as WorkspaceView)}
        tabs={[
          { id: 'structure', label: 'Structure', icon: <IconList size={11} /> },
          { id: 'graph',     label: 'Graph',     icon: <IconGraph size={11} /> },
        ]}
      />

      <span className="flex-1" />

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
            <span className="text-text-primary">{labelFor(GROUP_OPTIONS, group)}</span>
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
            <span className="text-text-primary">{labelFor(SORT_OPTIONS, sort)}</span>
          </ChipTrigger>
        )}
      />
    </div>
  );
}

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
 * Small chip-style action used by the Filter trigger — taller hover surface
 * and tighter padding than the generic ghost Button so the row reads as a
 * tool group, not a stack of unrelated CTAs.
 *
 * @param props - Chip configuration.
 * @returns Inline button with leading icon.
 */
function ChipButton({ active = false, onClick, icon, title, ariaPressed, children }: ChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed}
      className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 text-[12px] font-medium transition-colors ${
        active
          ? 'border-accent/30 bg-accent/10 text-accent-light'
          : 'border-transparent text-text-secondary hover:border-border-strong hover:bg-surface-hover'
      }`}
    >
      <span aria-hidden="true" className={active ? 'text-accent-light' : 'text-text-faint'}>
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
 * Visual mirror of {@link ChipButton} for use inside a {@link Dropdown}
 * trigger render prop — adds a chevron that rotates on open.
 *
 * @param props - Trigger configuration.
 * @returns Inline span styled like a chip.
 */
function ChipTrigger({ icon, open, children }: ChipTriggerProps) {
  return (
    <span
      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:bg-surface-hover"
    >
      <span aria-hidden="true" className="text-text-faint">{icon}</span>
      {children}
      <span aria-hidden="true" className="text-text-faint transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
        <IconChevronDown size={9} />
      </span>
    </span>
  );
}

export default FilterBar;
