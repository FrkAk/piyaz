"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MonoId } from "@/components/shared/MonoId";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import { STATUS_META, StatusGlyph } from "@/components/shared/StatusGlyph";
import type { AssignedTaskRow } from "@/lib/graph/queries";
import { listTasksAssignedToUser } from "@/lib/graph/queries";
import { myTasksKeys } from "@/lib/query/keys";
import type { TaskStatus } from "@/lib/types";

const STATUS_OPTIONS: readonly TaskStatus[] = [
  "draft",
  "planned",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];

const STATUS_OPTION_SET = new Set<TaskStatus>(STATUS_OPTIONS);

/** Default selection when `?status=` is absent — the active middle of the lifecycle. */
const DEFAULT_ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "planned",
  "in_progress",
  "in_review",
]);

/**
 * Cross-project assigned-tasks view. Reads server-dehydrated rows from
 * `myTasksKeys.list()` and renders them grouped by project. The status
 * pill row above the list filters in-process; the selection is mirrored
 * to `?status=<csv>` so reloads and deep-links preserve it.
 *
 * @returns The status pill row plus the grouped task list.
 */
export function MyTasksClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "/my-tasks";

  const activeStatuses = useMemo(
    () => parseStatusParam(searchParams.get("status")),
    [searchParams],
  );

  const { data } = useQuery<AssignedTaskRow[]>({
    queryKey: myTasksKeys.list(),
    queryFn: async () => {
      const payload = await listTasksAssignedToUser();
      if (!payload.ok) throw new Error(payload.code);
      return payload.rows;
    },
  });

  const rows = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => countByStatus(rows), [rows]);
  const visibleRows = useMemo(
    () => rows.filter((r) => activeStatuses.has(r.status)),
    [rows, activeStatuses],
  );
  const groups = useMemo(() => groupByProject(visibleRows), [visibleRows]);

  const toggleStatus = useCallback(
    (status: TaskStatus) => {
      const next = new Set(activeStatuses);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      const params = new URLSearchParams(searchParams.toString());
      if (setsEqual(next, DEFAULT_ACTIVE)) params.delete("status");
      else params.set("status", serializeStatusSet(next));
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [activeStatuses, pathname, router, searchParams],
  );

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-[15px] font-semibold text-text-primary">
          My tasks
        </h1>
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((status) => (
            <StatusPill
              key={status}
              status={status}
              count={counts[status]}
              active={activeStatuses.has(status)}
              onToggle={() => toggleStatus(status)}
            />
          ))}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="text-[12px] italic text-text-muted">
          You have no assigned tasks yet.
        </p>
      ) : activeStatuses.size === 0 ? (
        <p className="text-[12px] italic text-text-muted">
          Select a status above to see tasks.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-[12px] italic text-text-muted">
          No tasks match the selected statuses.
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

interface StatusPillProps {
  status: TaskStatus;
  count: number;
  active: boolean;
  onToggle: () => void;
}

function StatusPill({ status, count, active, onToggle }: StatusPillProps) {
  const label = STATUS_META[status]?.label ?? status;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={[
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors",
        active
          ? "border-border bg-surface-raised text-text-primary"
          : "border-border/60 bg-transparent text-text-muted hover:bg-surface-hover hover:text-text-secondary",
      ].join(" ")}
    >
      <StatusGlyph status={status} size={12} />
      <span>{label}</span>
      <span className="font-mono tabular-nums text-text-faint">{count}</span>
    </button>
  );
}

interface ProjectGroup {
  projectId: string;
  projectTitle: string;
  rows: AssignedTaskRow[];
}

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

function countByStatus(rows: AssignedTaskRow[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    draft: 0,
    planned: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    cancelled: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * Resolve the `?status=` param into a status set.
 * - absent (`null`) → default active set
 * - present-but-empty (`""`) → empty set (deliberate "show nothing")
 * - present CSV → exactly the listed statuses (unknown tokens dropped)
 */
function parseStatusParam(raw: string | null): ReadonlySet<TaskStatus> {
  if (raw === null) return DEFAULT_ACTIVE;
  if (raw === "") return new Set<TaskStatus>();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is TaskStatus => STATUS_OPTION_SET.has(p as TaskStatus));
  return new Set(parts);
}

/** Serialize in canonical lifecycle order so the URL is stable across toggles. */
function serializeStatusSet(set: ReadonlySet<TaskStatus>): string {
  return STATUS_OPTIONS.filter((s) => set.has(s)).join(",");
}

function setsEqual(
  a: ReadonlySet<TaskStatus>,
  b: ReadonlySet<TaskStatus>,
): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
