"use client";

import type { DisplayGroup } from "./predicates";
import { MyTasksGroup } from "./MyTasksGroup";
import { MyTasksRow } from "./MyTasksRow";

interface MyTasksListProps {
  groups: DisplayGroup[];
  collapsedKeys: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  meName: string;
}

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
                onToggle={
                  isDoneStatus ? () => onToggleCollapsed(group.key) : null
                }
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
