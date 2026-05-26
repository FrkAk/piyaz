"use client";

import type { DisplayGroup } from "./predicates";
import { MyTasksGroup } from "./MyTasksGroup";
import { MyTasksRow } from "./MyTasksRow";

interface MyTasksListProps {
  /** Discriminated group bundle (status / project / none). */
  groups: DisplayGroup[];
  /**
   * Set of collapsed group keys. Status keys are the `TaskState` value;
   * project keys are the project UUID; the `none` group has key `"all"`
   * and is never collapsible.
   */
  collapsedKeys: ReadonlySet<string>;
  /** Toggle a group's collapsed flag. Pass a no-op to lock collapse off. */
  onToggleCollapsed: (key: string) => void;
  /** Display name for the signed-in user's avatar slot. */
  meName: string;
}

/**
 * Card-wrapped grouped row list. Each group header sticks to the top of
 * the page scroll container; only status groups (and only `done` by
 * default) ship with a toggle. Project groups never collapse — operators
 * scan them by project name, and a collapsed project hides too much.
 *
 * @param props - Group payload + collapse state + signed-in user name.
 * @returns List card with one section per group.
 */
export function MyTasksList({
  groups,
  collapsedKeys,
  onToggleCollapsed,
  meName,
}: MyTasksListProps) {
  return (
    <div className="mt-3.5 overflow-hidden rounded-lg border border-border bg-surface/25">
      {groups.map((group) => {
        const isDoneStatus = group.kind === "status" && group.key === "done";
        const collapsed =
          group.kind === "status" && collapsedKeys.has(group.key);
        return (
          <section
            key={`${group.kind}:${group.key}`}
            aria-labelledby={`group-${group.key}`}
          >
            {group.kind === "status" && (
              <MyTasksGroup
                kind="status"
                state={group.key}
                count={group.rows.length}
                collapsed={collapsed}
                onToggle={isDoneStatus ? () => onToggleCollapsed(group.key) : null}
              />
            )}
            {group.kind === "project" && (
              <MyTasksGroup
                kind="project"
                projectIdentifier={group.projectIdentifier}
                projectTitle={group.projectTitle}
                projectColor={group.projectColor}
                count={group.rows.length}
              />
            )}
            {!collapsed && (
              <ul className="flex flex-col">
                {group.rows.map((row) => (
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
