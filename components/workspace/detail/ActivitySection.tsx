"use client";

import type { ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Avatar } from "@/components/shared/Avatar";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { MonoId } from "@/components/shared/MonoId";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";
import {
  IconArrowRight,
  IconBranch,
  IconCheck,
  IconDoc,
  IconFlag,
  IconLink,
  IconMore,
  IconPencil,
  IconPlus,
  IconSort,
  IconSpark,
  IconTag,
  IconUser,
} from "@/components/shared/icons";
import type { ActivityEvent, ActivityEventType } from "@/lib/types";
import { taskKeys } from "@/lib/query/keys";
import { formatRelative } from "@/components/workspace/structure/relativeTime";
import { SectionHeader } from "@/components/shared/SectionHeader";

interface ActivitySectionProps {
  /** Owning project id (for the query key). */
  projectId: string;
  /** Task whose activity to show. */
  taskId: string;
  /**
   * Project task lookup (id → display fields) already loaded by the detail
   * panel. Edge events resolve their connected task from this map, so the
   * activity feed adds no SQL or egress to name the connected task.
   */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
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
 * Activity timeline — consecutive events by the same actor collapse into one
 * cluster (avatar + name + harness badge shown once), each action rendered as a
 * glyph + humanized phrase + connected-task chip + relative time. Lazy-loaded
 * and paginated.
 *
 * @param props - Project + task identifiers.
 * @returns Section element, or null while empty.
 */
export function ActivitySection({
  projectId,
  taskId,
  taskMap,
}: ActivitySectionProps) {
  const {
    data,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: taskKeys.activity(projectId, taskId),
    queryFn: ({ pageParam }) => fetchActivity(taskId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const events = data?.pages.flatMap((p) => p.events) ?? [];
  // Alias to a plain boolean: branching on the destructured union flag itself
  // narrows the sibling bindings (e.g. `fetchNextPage`) to `never`, since no
  // result variant types this flag as `true`.
  const nextPageFailed: boolean = isFetchNextPageError;

  // A failed load must not look identical to "no activity" on an audit panel;
  // surface the failure with a retry instead of silently rendering nothing.
  if (isError) {
    return (
      <section className="mb-7">
        <SectionHeader label="Activity" />
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-text-secondary">
          <span>Couldn’t load activity.</span>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-text-faint underline hover:text-text-secondary"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (events.length === 0) return null;

  const groups = groupEvents(events);

  return (
    <section className="mb-7">
      <SectionHeader label="Activity" count={events.length} />
      <ul className="flex flex-col">
        {groups.map((group, i) => (
          <ActivityGroup
            key={group.key}
            group={group}
            isLast={i === groups.length - 1}
            taskMap={taskMap}
          />
        ))}
      </ul>
      {hasNextPage &&
        // A failed next-page load leaves `isError` false (the first page
        // succeeded), so surface that distinct failure with its own retry
        // rather than re-showing "Show more" as if nothing happened.
        (nextPageFailed ? (
          <div className="mt-2 flex items-center gap-2 pl-[32px] text-[11px] text-text-secondary">
            <span>Couldn’t load more.</span>
            <button
              type="button"
              onClick={() => fetchNextPage()}
              className="text-text-faint underline hover:text-text-secondary"
            >
              Retry
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="mt-2 pl-[32px] text-[11px] text-text-faint hover:text-text-secondary"
          >
            {isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        ))}
    </section>
  );
}

/** A run of consecutive events authored by the same actor. */
interface EventGroup {
  /** Stable key (first event id). */
  key: string;
  /** Display name. */
  name: string;
  /** Whether the actor is an agent (MCP source). */
  isAgent: boolean;
  /** Harness label (e.g. "Claude Code (plugin:…)"), agents only. */
  agent: string | null;
  /** Whether the harness client is verified (gates brand polish). */
  agentVerified: boolean;
  /** Actor avatar URL, when resolved. */
  avatar: string | null;
  /** Events in the run, newest-first. */
  events: ActivityEvent[];
}

/**
 * Collapse a newest-first event list into runs of consecutive same-actor
 * events. Identity is keyed on actor id + source + harness so a user action
 * and an agent action never merge even when names coincide.
 *
 * @param events - Flat, newest-first events.
 * @returns Ordered actor groups.
 */
function groupEvents(events: ActivityEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    const head = last?.events[0];
    const sameActor =
      head != null &&
      head.actorUserId === e.actorUserId &&
      head.source === e.source &&
      head.agent === e.agent;
    if (last && sameActor) {
      last.events.push(e);
      continue;
    }
    groups.push({
      key: e.id,
      name: e.actorName ?? (e.source === "web" ? "user" : "agent"),
      isAgent: e.source === "mcp",
      agent: e.agent,
      agentVerified: e.agentVerified,
      avatar: e.actorAvatar,
      events: [e],
    });
  }
  return groups;
}

interface ActivityGroupProps {
  /** Actor group to render. */
  group: EventGroup;
  /** Whether this is the last group — drops the trailing rail. */
  isLast: boolean;
  /** Project task lookup for resolving edge events' connected task. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
}

/**
 * One actor cluster — identity header plus the actor's action rows, joined to
 * the next cluster by a vertical rail behind the avatar.
 *
 * @param props - Group and position.
 * @returns List item element.
 */
function ActivityGroup({ group, isLast, taskMap }: ActivityGroupProps) {
  const agentLabel =
    group.isAgent && group.agent
      ? formatOAuthClientName(group.agent, group.agentVerified)
      : null;
  return (
    <li className="relative flex gap-2.5">
      <div className="flex w-[22px] shrink-0 flex-col items-center">
        <Avatar
          name={group.name}
          src={group.avatar ?? undefined}
          size={18}
          accent={group.isAgent}
        />
        {!isLast && (
          <span aria-hidden="true" className="mt-1.5 w-px flex-1 bg-border" />
        )}
      </div>
      <div className="min-w-0 flex-1 pb-3.5">
        <div className="flex min-w-0 items-center gap-1.5 pt-px">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-text-primary">
            {displayActor(group.name, group.isAgent)}
          </span>
          {agentLabel && (
            <span
              title={agentLabel}
              className="inline-flex max-w-[55%] shrink-0 items-center gap-1 rounded bg-accent-glow px-1.5 py-px font-mono text-[10px] text-accent-light"
            >
              <IconSpark size={9} className="shrink-0" />
              <span className="min-w-0 truncate">{agentLabel}</span>
            </span>
          )}
        </div>
        <ul className="mt-1 flex flex-col gap-0.5">
          {group.events.map((e) => (
            <ActivityActionRow key={e.id} event={e} taskMap={taskMap} />
          ))}
        </ul>
      </div>
    </li>
  );
}

interface ActivityActionRowProps {
  /** Event to render as a single action line. */
  event: ActivityEvent;
  /** Project task lookup for resolving the connected task of edge events. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
}

/**
 * Single action line — type glyph, humanized phrase, optional connected-task
 * chip, and a relative timestamp (absolute on hover). The connected task is
 * resolved from the page's existing `taskMap`, so the row issues no fetch.
 *
 * @param props - The event and the project task lookup.
 * @returns List item element.
 */
function ActivityActionRow({ event, taskMap }: ActivityActionRowProps) {
  const { icon, text, isEdge } = describeEvent(event);
  const chip =
    isEdge && event.targetRef ? taskMap.get(event.targetRef) : undefined;
  const change = isEdge ? null : fieldChange(event);
  return (
    <li className="flex items-center gap-2">
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-text-secondary">
        {isEdge ? (
          <>
            <span className="shrink-0">{text}</span>
            {chip ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <StatusGlyph status={chip.status} size={11} />
                <MonoId
                  id={chip.taskRef}
                  copyable={false}
                  dim
                  className="shrink-0 whitespace-nowrap"
                />
                <span className="min-w-0 truncate text-text-secondary">
                  {chip.title}
                </span>
              </span>
            ) : (
              <span className="shrink-0 text-text-muted">a task</span>
            )}
          </>
        ) : change ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{change.label}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-text-muted">
              {change.isStatus && (
                <span aria-hidden="true">
                  <StatusGlyph status={change.from} size={11} />
                </span>
              )}
              {change.from}
            </span>
            <IconArrowRight size={11} className="shrink-0 text-text-faint" />
            <span className="inline-flex min-w-0 items-center gap-1 font-medium text-text-primary">
              {change.isStatus && (
                <span aria-hidden="true">
                  <StatusGlyph status={change.to} size={11} />
                </span>
              )}
              <span className="truncate">{change.to}</span>
            </span>
          </span>
        ) : (
          <span className="min-w-0 truncate" title={text}>
            {text}
          </span>
        )}
      </span>
      <time
        dateTime={event.createdAt}
        title={new Date(event.createdAt).toLocaleString()}
        className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint"
      >
        {formatRelative(event.createdAt)}
      </time>
    </li>
  );
}

/** Humanized render parts for one event. */
interface EventDescription {
  /** Leading type glyph. */
  icon: ReactNode;
  /** Verb phrase; for edges it ends just before the connected-task chip. */
  text: string;
  /** Whether to render the connected-task chip after the phrase. */
  isEdge: boolean;
}

/**
 * Map an event to its glyph and human phrasing. Edge events are reworded from
 * the stored `added depends_on → target` form into plain language with
 * direction preserved; every other type keeps its already-readable summary.
 *
 * @param event - Event to describe.
 * @returns Glyph, phrase, and whether a connected-task chip follows.
 */
function describeEvent(event: ActivityEvent): EventDescription {
  if (
    event.type === "edge_added" ||
    event.type === "edge_removed" ||
    event.type === "edge_updated"
  ) {
    return describeEdge(event);
  }
  return { icon: iconForType(event.type), text: event.summary, isEdge: false };
}

/** Pure phrasing for an edge event: relation kind + directional verb phrase. */
export interface EdgePhrase {
  /** Relation kind, selecting the glyph in {@link describeEdge}. */
  kind: "depends" | "relates";
  /** Directional verb phrase preceding the connected-task chip. */
  text: string;
}

/**
 * Derive an edge event's relation kind and phrasing. The edge writer stores
 * `metadata.{direction,relation}`; this reads them directly. Backfilled /
 * legacy rows carry no edge metadata, so it falls back to parsing the stored
 * summary markers (`← source` = incoming). Pure (no JSX) so the contract is
 * unit-testable.
 *
 * @param event - An `edge_*` event.
 * @returns The relation kind and directional phrase.
 */
export function edgePhrase(event: ActivityEvent): EdgePhrase {
  const meta = event.metadata as
    | { direction?: string; relation?: string }
    | null
    | undefined;
  const incoming = meta?.direction
    ? meta.direction === "incoming"
    : event.summary.includes("← source");
  const isRelates = meta?.relation
    ? meta.relation === "relates_to"
    : event.summary.includes("relates_to");
  if (isRelates) {
    const text =
      event.type === "edge_added"
        ? "linked to"
        : event.type === "edge_removed"
          ? "removed the link to"
          : "updated the link to";
    return { kind: "relates", text };
  }
  const text = incoming
    ? event.type === "edge_added"
      ? "became a dependency of"
      : event.type === "edge_removed"
        ? "is no longer a dependency of"
        : "updated the dependency for"
    : event.type === "edge_added"
      ? "added a dependency on"
      : event.type === "edge_removed"
        ? "removed the dependency on"
        : "updated the dependency on";
  return { kind: "depends", text };
}

/**
 * Reword an edge event into its glyph + phrase + `isEdge` flag for rendering.
 *
 * @param event - An `edge_*` event.
 * @returns Glyph, directional phrase, and `isEdge: true`.
 */
function describeEdge(event: ActivityEvent): EventDescription {
  const { kind, text } = edgePhrase(event);
  const icon =
    kind === "relates" ? <IconLink size={12} /> : <IconBranch size={12} />;
  return { icon, text, isEdge: true };
}

/**
 * Pick a glyph for a non-edge event type so the feed is scannable by kind.
 *
 * @param type - Event type.
 * @returns A 12px icon element.
 */
function iconForType(type: ActivityEventType): ReactNode {
  switch (type) {
    case "task_created":
      return <IconPlus size={12} />;
    case "project_created":
      return <IconSpark size={12} />;
    case "title_changed":
    case "description_changed":
      return <IconPencil size={12} />;
    case "status_changed":
      return <IconArrowRight size={12} />;
    case "priority_changed":
    case "estimate_changed":
      return <IconFlag size={12} />;
    case "category_changed":
    case "tag_added":
    case "tag_removed":
      return <IconTag size={12} />;
    case "moved":
      return <IconSort size={12} />;
    case "plan_set":
    case "record_set":
    case "files_changed":
    case "decision_added":
    case "decision_removed":
    case "decision_edited":
      return <IconDoc size={12} />;
    case "assignee_added":
    case "assignee_removed":
      return <IconUser size={12} />;
    case "criterion_added":
    case "criterion_removed":
    case "criterion_edited":
    case "criterion_checked":
    case "criterion_unchecked":
      return <IconCheck size={12} />;
    case "link_added":
    case "link_removed":
    case "link_updated":
      return <IconLink size={12} />;
    default:
      return <IconMore size={12} />;
  }
}

/** Scalar-field change types whose `metadata.{from,to}` render as a transition. */
const FIELD_CHANGE_LABELS: Partial<Record<ActivityEventType, string>> = {
  status_changed: "status",
  priority_changed: "priority",
  estimate_changed: "estimate",
  category_changed: "category",
};

/** A resolved before → after transition for a scalar-field change event. */
interface FieldChange {
  /** Field label (e.g. "estimate"). */
  label: string;
  /** Prior value, stringified. */
  from: string;
  /** New value, stringified. */
  to: string;
  /** Whether both sides are task statuses (render a status glyph per side). */
  isStatus: boolean;
}

/**
 * Resolve a scalar field change to its before → after pair from the event's
 * `metadata` (already in the payload — no extra fetch). Returns null when the
 * event is not a tracked field change or either side is absent (a set-from-empty
 * or clear), so the caller falls back to the plain summary.
 *
 * @param event - Event to inspect.
 * @returns The transition, or null to use the summary.
 */
function fieldChange(event: ActivityEvent): FieldChange | null {
  const label = FIELD_CHANGE_LABELS[event.type];
  if (!label || !event.metadata) return null;
  const { from, to } = event.metadata;
  if (from == null || to == null) return null;
  const fromText = String(from);
  const toText = String(to);
  // category is a free-form string with no "" → null coercion upstream; an
  // empty side is a set-from-empty / clear, so fall back to the plain summary.
  if (fromText === "" || toText === "") return null;
  return {
    label,
    from: fromText,
    to: toText,
    isStatus: event.type === "status_changed",
  };
}

/**
 * Header label for an actor. Human (web) actors keep their name; agent (MCP)
 * actors render as the owning user's agent ("Furkan's Agent") so it is obvious
 * the action was taken by an agent on that person's behalf.
 *
 * @param name - Resolved actor name (or the "user" / "agent" fallback).
 * @param isAgent - Whether the actor is an agent (MCP source).
 * @returns Display label.
 */
function displayActor(name: string, isAgent: boolean): string {
  if (!isAgent) return name;
  const first = name.split(/\s+/)[0];
  if (!first || first === "agent") return "Agent";
  return `${first}'s Agent`;
}

export default ActivitySection;
