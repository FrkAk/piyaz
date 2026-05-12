'use client';

import { useMemo, type ReactNode } from 'react';
import { Avatar } from '@/components/shared/Avatar';
import { MonoId, type MonoIdTone } from '@/components/shared/MonoId';
import { PriorityIcon } from '@/components/shared/PriorityIcon';
import { StatusGlyph } from '@/components/shared/StatusGlyph';
import { useTheme } from '@/components/layout/ThemeProvider';
import type { Priority, TaskStatus } from '@/lib/types';
import type { MemberView } from '@/lib/actions/team-members-map';

interface TaskRowProps {
  /** Task UUID — used as React key by the parent. */
  id: string;
  /** Composed task identifier (e.g. `MYMR-104`). */
  taskRef: string;
  /** Display title. */
  title: string;
  /** Schema task status. */
  status: TaskStatus;
  /** First category — rendered as a tiny lowercase chip. */
  category?: string | null;
  /** Task priority, or null when unset. Drives the icon-only priority chip. */
  priority: Priority | null;
  /** User IDs assigned to this task. Drives the avatar stack. */
  assigneeUserIds: string[];
  /**
   * Map of `userId → MemberView` populated by the StructureView's team-member
   * query. Avatars resolve names through this lookup; missing entries fall
   * back to the userId fragment so the row never blocks on load.
   */
  memberLookup: ReadonlyMap<string, MemberView>;
  /** Count of upstream `depends_on` edges. */
  upstreamCount: number;
  /** Count of downstream `depends_on` edges (incoming). */
  downstreamCount: number;
  /** Last activity in compact form (e.g. `1h`, `2d`). */
  lastActive: string;
  /** Whether this row is the currently selected detail target. */
  selected: boolean;
  /** Whether the row is a derived `ready` state (planned + all deps done). */
  isReady: boolean;
  /** Whether the row is a derived `plannable` state (draft + criteria + done deps). */
  isPlannable: boolean;
  /** Click handler — opens the detail column for this task. */
  onClick: () => void;
  /** Trailing slot for an inline overflow menu (delete, etc). */
  trailing?: ReactNode;
  /**
   * Keep the trailing slot visible without hover — used when the slot is
   * rendering destructive confirmation UI that the operator must commit or
   * cancel before the row de-emphasises again.
   */
  trailingPersistent?: boolean;
}

/**
 * Format the task title with the right de-emphasis for non-active states —
 * done/cancelled rows are muted, cancelled also struck through.
 *
 * @param status - Task status driving the title classes.
 * @returns Tailwind class string for the title span.
 */
function titleClass(status: TaskStatus): string {
  if (status === 'cancelled') return 'text-text-muted line-through';
  if (status === 'done') return 'text-text-muted';
  return 'text-text-primary';
}

/**
 * Linear-density task row — single 34px line with status glyph, mono id,
 * dependency hints, category, title, last-active and assignee slot.
 *
 * @param props - Row data.
 * @returns Clickable row with hover and selected variants.
 */
export function TaskRow({
  id,
  taskRef,
  title,
  status,
  category,
  priority,
  assigneeUserIds,
  memberLookup,
  upstreamCount,
  downstreamCount,
  lastActive,
  selected,
  isReady,
  isPlannable,
  onClick,
  trailing,
  trailingPersistent = false,
}: TaskRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      data-task-id={id}
      data-task-ref={taskRef}
      className={`group relative flex h-[34px] cursor-pointer items-center gap-2.5 border-b border-border pl-4 pr-3 transition-colors duration-100 ${
        selected
          ? 'bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]'
          : 'hover:bg-surface-raised/40'
      }`}
    >
      {selected && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px]" style={{ background: 'var(--color-accent-grad)' }} />
      )}

      {(() => {
        const stage =
          isPlannable && status === 'draft'
            ? 'plannable'
            : isReady && status === 'planned'
              ? 'ready'
              : status;
        return (
          <>
            <StatusGlyph
              status={stage}
              size={14}
              className={status === 'in_progress' ? 'status-pulse' : undefined}
            />

            <MonoId
              id={taskRef}
              dim={status === 'done' || status === 'cancelled'}
              tone={stage as MonoIdTone}
            />
          </>
        );
      })()}

      <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${titleClass(status)}`}>
        {title}
      </span>

      {upstreamCount > 0 && <DepsHint icon="up" count={upstreamCount} />}

      {downstreamCount > 0 && <DepsHint icon="down" count={downstreamCount} />}

      {category && <CategoryChip name={category} />}

      {priority && <PriorityChip priority={priority} />}

      <span
        className="-ml-1 inline-block w-5 shrink-0 text-right font-mono text-[10px] tabular-nums text-text-faint"
        title={`Last updated ${lastActive}`}
      >
        {lastActive}
      </span>

      <span className="-ml-1 flex w-8 shrink-0 items-center justify-end">
        <AssigneeStack userIds={assigneeUserIds} memberLookup={memberLookup} />
      </span>

      {trailing && (
        <span
          className={`absolute inset-y-0 right-1.5 flex items-center pl-6 transition-opacity duration-150 ${
            trailingPersistent
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
          }`}
          style={{
            background: selected
              ? 'linear-gradient(to left, color-mix(in srgb, var(--color-accent) 6%, var(--color-base)) 50%, transparent 100%)'
              : 'linear-gradient(to left, var(--color-base) 50%, transparent 100%)',
          }}
        >
          {trailing}
        </span>
      )}
    </div>
  );
}

/**
 * Hash a string to a stable index — drives the deterministic pastel palette
 * applied to category chips. Same string maps to the same color forever.
 *
 * @param input - String to hash.
 * @returns Non-negative integer suitable for modulus.
 */
function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h * 31) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Stable hue palette per category — same string maps to the same hue across themes. */
const CATEGORY_HUES: readonly number[] = [205, 162, 280, 32, 220, 138, 12, 254, 312, 88];

/**
 * Mono lowercase category chip — hue is hashed deterministically from the
 * name so categories scan consistently across rows. Background, border, and
 * text values branch on theme so dark mode shows light pastel text on a
 * tinted dark surface, while light mode shows saturated dark text on a
 * near-white pastel tint.
 *
 * @param props - Category name.
 * @returns Inline chip element with theme-aware color.
 */
function CategoryChip({ name }: { name: string }) {
  const hue = CATEGORY_HUES[hashString(name) % CATEGORY_HUES.length];
  const { theme } = useTheme();
  const isLight = theme === 'light';
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium"
      style={{
        background: isLight ? `hsl(${hue} 65% 92%)` : `hsl(${hue} 70% 45% / 0.14)`,
        border: `1px solid ${isLight ? `hsl(${hue} 45% 62% / 0.5)` : `hsl(${hue} 70% 60% / 0.25)`}`,
        color: isLight ? `hsl(${hue} 55% 28%)` : `hsl(${hue} 75% 78%)`,
      }}
    >
      {name.toLowerCase()}
    </span>
  );
}

interface DepsHintProps {
  /** `up` for upstream `depends_on`, `down` for downstream. */
  icon: 'up' | 'down';
  /** Edge count to render. */
  count: number;
}

/**
 * Tiny mono dependency hint — `↑3` for upstream, `↓1` for downstream. The
 * arrow color cues the edge category (depends-on vs related-to).
 *
 * @param props - Direction and count.
 * @returns Inline-flex span rendering arrow + count.
 */
function DepsHint({ icon, count }: DepsHintProps) {
  return (
    <span className="hidden shrink-0 items-center gap-0.5 font-mono text-[10px] text-text-muted sm:inline-flex" title={icon === 'up' ? `${count} upstream` : `${count} downstream`}>
      <span style={{ color: icon === 'up' ? 'var(--color-depends)' : 'var(--color-relates)' }}>
        {icon === 'up' ? '↑' : '↓'}
      </span>
      <span className="tabular-nums">{count}</span>
    </span>
  );
}

interface PriorityChipProps {
  /** Active priority — null is filtered out at the call site. */
  priority: Priority;
}

/**
 * Icon-only priority badge — `PriorityIcon` inside a
 * 14×14 inline-flex slot with a tooltip carrying the schema value. The
 * row passes a non-null priority; the null check happens before render so
 * unset rows lose the slot entirely.
 *
 * @param props - Priority value.
 * @returns Inline-flex chip element.
 */
function PriorityChip({ priority }: PriorityChipProps) {
  // `PriorityIcon` carries the accessible name via its own `aria-label`. The
  // chip span just provides the hit box, so it stays unlabeled to avoid a
  // duplicate announcement.
  return (
    <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center">
      <PriorityIcon priority={priority} />
    </span>
  );
}

interface AssigneeStackProps {
  /** User IDs assigned to the task, ordered as the slim payload returns. */
  userIds: readonly string[];
  /** Lookup keyed by userId — undefined entries fall back to the id fragment. */
  memberLookup: ReadonlyMap<string, MemberView>;
}

/**
 * Up to two overlapping 18px avatars plus a `+N` overflow chip when more
 * than two users are assigned. Renders a dashed-circle placeholder when
 * nobody is assigned — the slot stays in the row so the right cluster
 * doesn't shift between assigned and unassigned tasks.
 *
 * @param props - Assignee user IDs and lookup map.
 * @returns Inline-flex stack element.
 */
function AssigneeStack({ userIds, memberLookup }: AssigneeStackProps) {
  // Re-sort by member name so the first two avatars match `PropRail`'s
  // trigger and the server-returned ordering. The slim graph subquery
  // returns user-id-sorted ids for determinism; the client picks the
  // user-visible order. Ids that aren't in the cache yet fall to the end
  // (sorted by id fragment) so they don't shuffle visible avatars while
  // the team-member roster is loading. Memoised because the row re-renders
  // on every StructureView pass — multiplying a tiny sort by row count.
  // Computed before the empty-stack early return so the hook order stays
  // consistent across renders.
  const sortedUserIds = useMemo(() => {
    return [...userIds].sort((a, b) => {
      const an = memberLookup.get(a)?.name;
      const bn = memberLookup.get(b)?.name;
      if (an && bn) return an.localeCompare(bn);
      if (an) return -1;
      if (bn) return 1;
      return a.localeCompare(b);
    });
  }, [userIds, memberLookup]);

  if (userIds.length === 0) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-dashed border-border-strong"
        title="Unassigned"
      >
        <span className="sr-only">Unassigned</span>
      </span>
    );
  }
  const visible = sortedUserIds.slice(0, 2);
  const overflow = sortedUserIds.length - visible.length;
  return (
    <span className="inline-flex items-center">
      {visible.map((userId, i) => {
        const member = memberLookup.get(userId);
        const label = member?.name ?? userId.slice(0, 4);
        const isLastVisible = i === visible.length - 1;
        return (
          <span
            key={userId}
            className={`relative ${i === 0 ? '' : '-ml-2'}`}
            title={member?.name ?? `User ${userId.slice(0, 8)}`}
          >
            <Avatar name={label} size={18} />
            {isLastVisible && overflow > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 inline-flex h-[11px] min-w-[11px] items-center justify-center rounded-full border border-border-strong bg-surface-raised px-[2px] font-mono text-[7.5px] font-semibold leading-none text-text-secondary"
                title={`${overflow} more assignee${overflow === 1 ? '' : 's'}`}
              >
                +{overflow}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export default TaskRow;
