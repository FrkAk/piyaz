"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Avatar } from "@/components/shared/Avatar";
import type { ActivityEvent } from "@/lib/types";
import { taskKeys } from "@/lib/query/keys";
import { SectionHeader } from "./SectionHeader";

interface ActivitySectionProps {
  /** Owning project id (for the query key). */
  projectId: string;
  /** Task whose activity to show. */
  taskId: string;
}

interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
}

/**
 * Fetch one page of activity for a task.
 * @param taskId - Task id.
 * @param cursor - Opaque keyset cursor or null for the first page.
 * @returns The page payload.
 * @throws Error when the request fails.
 */
async function fetchActivity(
  taskId: string,
  cursor: string | null,
): Promise<ActivityPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await fetch(`/api/task/${taskId}/events${qs}`);
  if (!res.ok) throw new Error(`activity ${res.status}`);
  return res.json();
}

/**
 * Activity timeline — avatar + actor name + harness badge + entity-referencing
 * summary + relative time (absolute on hover). Lazy-loaded and paginated.
 *
 * @param props - Project + task identifiers.
 * @returns Section element, or null while empty.
 */
export function ActivitySection({ projectId, taskId }: ActivitySectionProps) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: taskKeys.activity(projectId, taskId),
      queryFn: ({ pageParam }) => fetchActivity(taskId, pageParam),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
    });

  const events = data?.pages.flatMap((p) => p.events) ?? [];
  if (events.length === 0) return null;

  return (
    <section className="mb-7">
      <SectionHeader label="Activity" count={events.length} />
      <ul className="flex flex-col">
        {events.map((e, i) => (
          <ActivityRow key={e.id} event={e} isLast={i === events.length - 1} />
        ))}
      </ul>
      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-2 text-[11px] text-text-faint hover:text-text-secondary"
        >
          {isFetchingNextPage ? "Loading…" : "Show more"}
        </button>
      )}
    </section>
  );
}

interface ActivityRowProps {
  /** Event to render. */
  event: ActivityEvent;
  /** Whether this is the last row — controls the trailing connector. */
  isLast: boolean;
}

/**
 * Single timeline row.
 * @param props - Row configuration.
 * @returns List item element.
 */
function ActivityRow({ event, isLast }: ActivityRowProps) {
  const name = event.actorName ?? (event.source === "web" ? "user" : "agent");
  const isAgent = event.source === "mcp";
  return (
    <li className="relative flex items-center gap-2.5 py-2">
      <span className="relative flex w-[22px] justify-center">
        <Avatar
          name={name}
          src={event.actorAvatar ?? undefined}
          size={18}
          accent={isAgent}
        />
        {!isLast && (
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-[22px] h-[calc(100%+8px)] w-px -translate-x-1/2 bg-border"
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">
        <span className="font-medium text-text-primary">{name}</span>
        {isAgent && event.agent && (
          <span className="ml-1 rounded bg-surface-raised px-1 py-px font-mono text-[9px] text-text-faint">
            {event.agent}
          </span>
        )}{" "}
        {event.summary}
      </span>
      <span
        className="font-mono text-[10px] tabular-nums text-text-faint"
        title={new Date(event.createdAt).toLocaleString()}
      >
        {formatRelative(event.createdAt)}
      </span>
    </li>
  );
}

/**
 * Compact relative-time formatter.
 * @param iso - ISO date string.
 * @returns Short relative label, or `—` if unparseable.
 */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 4) return `${week}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

export default ActivitySection;
