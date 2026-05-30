"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo } from "react";
import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";
import { MyTasksGroup } from "./MyTasksGroup";
import { MyTasksRow } from "./MyTasksRow";
import type { DisplayGroup } from "./predicates";

interface MyTasksListProps {
  groups: DisplayGroup[];
  collapsedKeys: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  meName: string;
  /** Page scroll container owned by `MyTasksClient` — drives virtualization. */
  scrollEl: HTMLDivElement | null;
}

// Header heights match `MyTasksGroup` (h-[30px] + border-b = 31px) and
// row heights match `MyTasksRow` (h-[34px] + border-b = 35px). Fixed
// estimates avoid `measureElement` round-trips for the common case.
const HEADER_HEIGHT = 31;
const ROW_HEIGHT = 35;

type FlatItem =
  | {
      kind: "status-header";
      key: string;
      headerId: string;
      state: TaskState;
      count: number;
      collapsible: boolean;
      collapsed: boolean;
    }
  | {
      kind: "project-header";
      key: string;
      headerId: string;
      projectIdentifier: string;
      projectTitle: string;
      projectColor: string;
      count: number;
    }
  | {
      kind: "row";
      key: string;
      row: MyTask;
    };

function flattenGroups(
  groups: readonly DisplayGroup[],
  collapsedKeys: ReadonlySet<string>,
): FlatItem[] {
  const items: FlatItem[] = [];
  for (const group of groups) {
    if (group.kind === "status") {
      const isDone = group.key === "done";
      const collapsed = collapsedKeys.has(group.key);
      items.push({
        kind: "status-header",
        key: `header:status:${group.key}`,
        headerId: `my-tasks-group-status-${group.key}`,
        state: group.key,
        count: group.rows.length,
        collapsible: isDone,
        collapsed,
      });
      if (!collapsed) {
        for (const row of group.rows) {
          items.push({ kind: "row", key: row.id, row });
        }
      }
    } else if (group.kind === "project") {
      items.push({
        kind: "project-header",
        key: `header:project:${group.key}`,
        headerId: `my-tasks-group-project-${group.key}`,
        projectIdentifier: group.projectIdentifier,
        projectTitle: group.projectTitle,
        projectColor: group.projectColor,
        count: group.rows.length,
      });
      for (const row of group.rows) {
        items.push({ kind: "row", key: row.id, row });
      }
    } else {
      for (const row of group.rows) {
        items.push({ kind: "row", key: row.id, row });
      }
    }
  }
  return items;
}

export function MyTasksList({
  groups,
  collapsedKeys,
  onToggleCollapsed,
  meName,
  scrollEl,
}: MyTasksListProps) {
  const flatItems = useMemo(
    () => flattenGroups(groups, collapsedKeys),
    [groups, collapsedKeys],
  );

  // `useVirtualizer` uses interior mutability; React Compiler auto-skip is safe.
  // https://react.dev/reference/eslint-plugin-react-hooks/lints/incompatible-library
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollEl,
    estimateSize: (index) =>
      flatItems[index]?.kind === "row" ? ROW_HEIGHT : HEADER_HEIGHT,
    getItemKey: (index) => flatItems[index]?.key ?? index,
    overscan: 8,
  });

  return (
    <div className="mt-3.5 overflow-hidden rounded-lg border border-border bg-surface/25">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const item = flatItems[vi.index];
          if (!item) return null;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {item.kind === "status-header" && (
                <MyTasksGroup
                  kind="status"
                  headerId={item.headerId}
                  state={item.state}
                  count={item.count}
                  collapsed={item.collapsed}
                  onToggle={
                    item.collapsible
                      ? () => onToggleCollapsed(item.state)
                      : null
                  }
                />
              )}
              {item.kind === "project-header" && (
                <MyTasksGroup
                  kind="project"
                  headerId={item.headerId}
                  projectIdentifier={item.projectIdentifier}
                  projectTitle={item.projectTitle}
                  projectColor={item.projectColor}
                  count={item.count}
                />
              )}
              {item.kind === "row" && (
                <MyTasksRow row={item.row} meName={meName} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
