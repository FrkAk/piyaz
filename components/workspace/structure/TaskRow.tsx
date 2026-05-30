"use client";

import { memo, useMemo } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { CategoryDot } from "@/components/shared/CategoryDot";
import { DepsHint } from "@/components/shared/DepsHint";
import { IconTrash } from "@/components/shared/icons";
import { MonoId, type MonoIdTone } from "@/components/shared/MonoId";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import type { Priority, TaskStatus } from "@/lib/types";
import type { MemberView } from "@/lib/actions/team-members-map";
import { DeleteConfirm } from "./DeleteConfirm";

interface TaskRowProps {
  /** Task UUID — used as React key by the parent. */
  id: string;
  /** Composed task identifier (e.g. `MYMR-104`). */
  taskRef: string;
  /** Display title. */
  title: string;
  /** Schema task status. */
  status: TaskStatus;
  /** First category — rendered as a CategoryDot affordance. */
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
  /**
   * Open the detail column for this task. Takes the task `id` so the parent
   * can pass a single stable callback (`onSelectNode`) regardless of which
   * row is being rendered — preserves memoisation.
   */
  onSelect: (id: string) => void;
  /**
   * Begin the inline delete-confirm flow for this task. Receives `id` so the
   * parent can resolve the relevant task; the parent owns the active
   * confirmation state (the prefetch effect rides on it) and toggles
   * `confirming` on the right row.
   */
  onRequestDelete?: (id: string) => void;
  /** Commit the delete for this task. */
  onConfirmDelete?: (id: string) => void;
  /** Cancel the delete-confirm flow. */
  onCancelDelete?: () => void;
  /**
   * `true` when this row is the active confirm target. Drives the trailing
   * slot's persistent visibility while the operator commits or cancels.
   */
  confirming?: boolean;
}

/**
 * Format the task title with the right de-emphasis for non-active states —
 * done/cancelled rows are muted, cancelled also struck through.
 *
 * @param status - Task status driving the title classes.
 * @returns Tailwind class string for the title span.
 */
function titleClass(status: TaskStatus): string {
  if (status === "cancelled") return "text-text-muted line-through";
  if (status === "done") return "text-text-muted";
  return "text-text-primary";
}

/**
 * Linear-density task row — single 34px line with status glyph, mono id,
 * dependency hints, category dot, title, last-active and assignee slot.
 * Wrapped in `React.memo` so unchanged rows skip re-render when the parent
 * `StructureView` updates (e.g. on selection change of an adjacent row).
 *
 * @param props - Row data.
 * @returns Clickable row with hover and selected variants.
 */
function TaskRowImpl({
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
  onSelect,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  confirming = false,
}: TaskRowProps) {
  const handleClick = () => onSelect(id);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-task-id={id}
      data-task-ref={taskRef}
      className={`group relative flex h-[34px] cursor-pointer items-center gap-2.5 border-b border-border pl-4 pr-3 transition-colors duration-100 ${
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]"
          : "hover:bg-surface-raised/40"
      }`}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[2px]"
          style={{ background: "var(--color-accent-grad)" }}
        />
      )}

      {(() => {
        const stage =
          isPlannable && status === "draft"
            ? "plannable"
            : isReady && status === "planned"
              ? "ready"
              : status;
        return (
          <>
            <StatusGlyph
              status={stage}
              size={14}
              className={status === "in_progress" ? "status-pulse" : undefined}
            />

            <MonoId
              id={taskRef}
              dim={status === "done" || status === "cancelled"}
              tone={stage as MonoIdTone}
            />
          </>
        );
      })()}

      <span
        className={`min-w-0 flex-1 truncate text-[13px] font-medium ${titleClass(status)}`}
      >
        {title}
      </span>

      {upstreamCount > 0 && <DepsHint icon="up" count={upstreamCount} />}

      {downstreamCount > 0 && <DepsHint icon="down" count={downstreamCount} />}

      {category && <CategoryDot name={category} />}

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

      {onRequestDelete && (
        <span
          className={`absolute inset-y-0 right-1.5 flex items-center pl-6 transition-opacity duration-150 ${
            confirming
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          }`}
          style={{
            background: selected
              ? "linear-gradient(to left, color-mix(in srgb, var(--color-accent) 6%, var(--color-base)) 50%, transparent 100%)"
              : "linear-gradient(to left, var(--color-base) 50%, transparent 100%)",
          }}
        >
          {confirming && onConfirmDelete && onCancelDelete ? (
            <DeleteConfirm
              onConfirm={() => onConfirmDelete(id)}
              onCancel={onCancelDelete}
            />
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete(id);
              }}
              className="cursor-pointer rounded p-1 text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-danger"
              aria-label={`Delete ${taskRef}`}
              title={`Delete ${taskRef}`}
            >
              <IconTrash size={11} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Memoised export — `TaskRowImpl` only re-renders when its shallow-compared
 * props change. With the tightened parent API (`onSelect` instead of inline
 * `onClick`, `onRequestDelete` / `onConfirmDelete` / `onCancelDelete`
 * instead of inline `trailing` JSX), all function references are stable
 * across `StructureView` re-renders, so unchanged rows skip render cleanly.
 */
export const TaskRow = memo(TaskRowImpl);

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
            className={`relative ${i === 0 ? "" : "-ml-2"}`}
            title={member?.name ?? `User ${userId.slice(0, 8)}`}
          >
            <Avatar name={label} size={18} />
            {isLastVisible && overflow > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 inline-flex h-[11px] min-w-[11px] items-center justify-center rounded-full border border-border-strong bg-surface-raised px-[2px] font-mono text-[7.5px] font-semibold leading-none text-text-secondary"
                title={`${overflow} more assignee${overflow === 1 ? "" : "s"}`}
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
