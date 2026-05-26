"use client";

import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";
import type { StateGroup } from "./predicates";
import { MyTasksGroup } from "./MyTasksGroup";
import { MyTasksRow } from "./MyTasksRow";

interface MyTasksListProps {
  /** Groups ordered per `GROUP_ORDER`. */
  groups: StateGroup[];
  /** Set of states currently collapsed in the UI. */
  collapsedStates: ReadonlySet<TaskState>;
  /** Toggle a group's collapsed flag. */
  onToggleCollapsed: (state: TaskState) => void;
  /** Display name for the signed-in user's avatar slot. */
  meName: string;
}

/**
 * Card-wrapped grouped row list. Each `MyTasksGroup` sticks to the top of
 * the page scroll container; only the `done` group ships with a toggle
 * (others stay open in v1 per DESIGN.md § 6a).
 *
 * @param props - Group payload + collapse state + signed-in user name.
 * @returns List card with one section per state.
 */
export function MyTasksList({
  groups,
  collapsedStates,
  onToggleCollapsed,
  meName,
}: MyTasksListProps) {
  return (
    <div className="mt-3.5 overflow-hidden rounded-lg border border-border bg-surface/25">
      {groups.map((group) => {
        const isDone = group.state === "done";
        const collapsed = collapsedStates.has(group.state);
        return (
          <section key={group.state} aria-labelledby={`group-${group.state}`}>
            <MyTasksGroup
              state={group.state}
              count={group.rows.length}
              collapsed={collapsed}
              onToggle={isDone ? () => onToggleCollapsed(group.state) : null}
            />
            {!collapsed && (
              <ul className="flex flex-col">
                {group.rows.map((row: MyTask) => (
                  <li key={row.id}>
                    <MyTasksRow row={row} meName={meName} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
