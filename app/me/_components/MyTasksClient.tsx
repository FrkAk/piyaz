"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MonoId } from "@/components/shared/MonoId";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import type { AssignedTaskRow } from "@/lib/graph/queries";
import { listTasksAssignedToUser } from "@/lib/graph/queries";
import { myTasksKeys } from "@/lib/query/keys";
import type { TaskStatus } from "@/lib/types";

/** Statuses shown by default — active work the user can act on now. */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "planned",
  "in_progress",
  "in_review",
]);

/**
 * Cross-project assigned-tasks view. Reads server-dehydrated rows from
 * `myTasksKeys.list()`; the "show all" toggle filters in-process so no
 * refetch is needed when expanding to draft / done / cancelled.
 *
 * @returns Grouped list with status, priority, and taskRef per row.
 */
export function MyTasksClient() {
  const [showAll, setShowAll] = useState(false);
  const { data } = useQuery<AssignedTaskRow[]>({
    queryKey: myTasksKeys.list(),
    queryFn: async () => {
      const payload = await listTasksAssignedToUser();
      if (!payload.ok) throw new Error(payload.code);
      return payload.rows;
    },
  });

  const rows = useMemo(() => data ?? [], [data]);
  const visibleRows = useMemo(
    () => (showAll ? rows : rows.filter((r) => ACTIVE_STATUSES.has(r.status))),
    [rows, showAll],
  );

  const groups = useMemo(() => groupByProject(visibleRows), [visibleRows]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold text-text-primary">
          My tasks
        </h1>
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show all statuses
        </label>
      </header>

      {rows.length === 0 ? (
        <p className="text-[12px] italic text-text-muted">
          You have no assigned tasks yet.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-[12px] italic text-text-muted">
          No active assignments. Toggle &ldquo;Show all statuses&rdquo; to see
          everything.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.projectId} className="flex flex-col gap-1">
              <h2 className="flex items-baseline gap-2 px-2 text-[11px] font-semibold uppercase tracking-[0.10em] text-text-muted">
                <Link
                  href={`/project/${group.projectId}`}
                  className="text-text-secondary hover:text-text-primary"
                >
                  {group.projectTitle}
                </Link>
                <span className="font-mono tabular-nums text-text-faint">
                  {group.rows.length}
                </span>
              </h2>
              <ul className="flex flex-col">
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/project/${row.projectId}?task=${row.id}`}
                      className="flex h-[34px] items-center gap-2.5 border-b border-border pl-4 pr-3 transition-colors hover:bg-surface-raised/40"
                    >
                      <StatusGlyph status={row.status} size={14} />
                      <MonoId
                        id={row.taskRef}
                        dim={
                          row.status === "done" || row.status === "cancelled"
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
                        {row.title}
                      </span>
                      {row.priority && (
                        <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                          <PriorityIcon priority={row.priority} />
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

interface ProjectGroup {
  projectId: string;
  projectTitle: string;
  rows: AssignedTaskRow[];
}

/**
 * Bucket rows under their owning project, preserving the input order so
 * the most-recently-updated project surfaces first.
 *
 * @param rows - Assigned task rows already ordered `updatedAt DESC`.
 * @returns Project groups in first-seen order.
 */
function groupByProject(rows: AssignedTaskRow[]): ProjectGroup[] {
  const buckets = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const existing = buckets.get(row.projectId);
    if (existing) {
      existing.rows.push(row);
    } else {
      buckets.set(row.projectId, {
        projectId: row.projectId,
        projectTitle: row.projectTitle,
        rows: [row],
      });
    }
  }
  return [...buckets.values()];
}
