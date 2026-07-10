"use client";

import type { ReactNode } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar } from "@/components/shared/Avatar";
import {
  IconMore,
  IconPencil,
  IconPlus,
  IconSort,
  IconSpark,
  IconTrash,
  IconUndo,
} from "@/components/shared/icons";
import { SectionHeader } from "@/components/shared/SectionHeader";
import { formatRelative } from "@/components/workspace/structure/relativeTime";
import { formatOAuthClientName } from "@/lib/ui/oauth-client-name";
import { conditionalFetchPage } from "@/lib/query/conditional-fetch";
import { noteKeys } from "@/lib/query/keys";
import type { NoteActivityEvent } from "@/lib/types";

interface NoteHistoryProps {
  /** @param projectId - Owning project id (for the query key). */
  projectId: string;
  /** @param noteId - Note whose activity to show. */
  noteId: string;
}

/** Payload of one `GET /api/note/[noteId]/events` keyset page. */
interface NoteEventsPage {
  events: NoteActivityEvent[];
  nextCursor: string | null;
}

/**
 * Per-note activity timeline for the settings ribbon: consecutive events by
 * the same actor collapse into one cluster (avatar + name + harness badge
 * shown once), each action a `note_*` glyph + summary + relative time.
 * Restore-to-version writes get their own glyph and caption from
 * `metadata.restoredFromVersion`. Paginated with a "Show more" tail;
 * failures surface with a retry instead of rendering as "no activity".
 *
 * @param props - Project scope and the open note.
 * @returns The History ribbon section.
 */
export function NoteHistory({ projectId, noteId }: NoteHistoryProps) {
  const qc = useQueryClient();
  const {
    data,
    isPending,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: noteKeys.events(projectId, noteId),
    queryFn: ({ pageParam, signal }) =>
      conditionalFetchPage<NoteEventsPage>({
        url: pageParam
          ? `/api/note/${noteId}/events?cursor=${encodeURIComponent(pageParam)}`
          : `/api/note/${noteId}/events`,
        queryKey: noteKeys.events(projectId, noteId),
        pageParam,
        queryClient: qc,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const events = data?.pages.flatMap((p) => p.events) ?? [];
  const nextPageFailed: boolean = isFetchNextPageError;

  return (
    <div className="mt-6 border-t border-border pt-4">
      <SectionHeader
        label="History"
        count={events.length > 0 ? events.length : undefined}
      />
      {isPending ? (
        <div className="space-y-2" role="status" aria-label="Loading history">
          <span className="skeleton-bar block h-4 w-3/4" />
          <span
            className="skeleton-bar block h-4 w-2/3"
            style={{ "--skeleton-delay": "70ms" } as React.CSSProperties}
          />
          <span
            className="skeleton-bar block h-4 w-3/4"
            style={{ "--skeleton-delay": "140ms" } as React.CSSProperties}
          />
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 py-1 text-[12px] text-text-secondary">
          <span>Couldn&rsquo;t load history.</span>
          <button
            type="button"
            onClick={() => refetch()}
            className="cursor-pointer text-text-faint underline hover:text-text-secondary"
          >
            Retry
          </button>
        </div>
      ) : events.length === 0 ? (
        <div className="py-0.5 text-[12px] text-text-faint">
          No recorded changes yet.
        </div>
      ) : (
        <>
          <ul className="flex flex-col">
            {groupEvents(events).map((group, i, all) => (
              <NoteEventGroup
                key={group.key}
                group={group}
                isLast={i === all.length - 1}
              />
            ))}
          </ul>
          {hasNextPage &&
            (nextPageFailed ? (
              <div className="mt-1 flex items-center gap-2 pl-[30px] text-[11px] text-text-secondary">
                <span>Couldn&rsquo;t load more.</span>
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  className="cursor-pointer text-text-faint underline hover:text-text-secondary"
                >
                  Retry
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="mt-1 cursor-pointer pl-[30px] text-[11px] text-text-faint hover:text-text-secondary disabled:cursor-default"
              >
                {isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            ))}
        </>
      )}
    </div>
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
  /** Harness label, agents only. */
  agent: string | null;
  /** Whether the harness client is verified. */
  agentVerified: boolean;
  /** Actor avatar URL, when resolved. */
  avatar: string | null;
  /** Events in the run, newest-first. */
  events: NoteActivityEvent[];
}

/**
 * Collapse a newest-first event list into runs of consecutive same-actor
 * events, keyed on actor id + source + harness so a user action and an
 * agent action never merge even when names coincide.
 *
 * @param events - Flat, newest-first events.
 * @returns Ordered actor groups.
 */
function groupEvents(events: NoteActivityEvent[]): EventGroup[] {
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

interface NoteEventGroupProps {
  /** Actor group to render. */
  group: EventGroup;
  /** Whether this is the last group, which drops the trailing rail. */
  isLast: boolean;
}

/**
 * One actor cluster: identity header plus the actor's action rows, joined
 * to the next cluster by a vertical rail behind the avatar. Compact sibling
 * of the task detail's `ActivityGroup`, sized for the 352px ribbon.
 *
 * @param props - Group and position.
 * @returns List item element.
 */
function NoteEventGroup({ group, isLast }: NoteEventGroupProps) {
  const agentLabel =
    group.isAgent && group.agent
      ? formatOAuthClientName(group.agent, group.agentVerified)
      : null;
  return (
    <li className="relative flex gap-2">
      <div className="flex w-[20px] shrink-0 flex-col items-center">
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
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex min-w-0 items-center gap-1.5 pt-px">
          <span className="min-w-0 truncate text-[12px] font-medium text-text-primary">
            {displayActor(group.name, group.isAgent)}
          </span>
          {agentLabel && (
            <span
              title={agentLabel}
              className="inline-flex max-w-[55%] shrink-0 items-center gap-1 rounded bg-accent-glow px-1.5 py-px font-mono text-[9.5px] text-accent-light"
            >
              <IconSpark size={9} className="shrink-0" />
              <span className="min-w-0 truncate">{agentLabel}</span>
            </span>
          )}
        </div>
        <ul className="mt-1 flex flex-col gap-0.5">
          {group.events.map((e) => {
            const { icon, text } = describeNoteEvent(e);
            return (
              <li key={e.id} className="flex items-center gap-2">
                <span className="shrink-0 text-text-muted">{icon}</span>
                <span
                  className="min-w-0 flex-1 truncate text-[12px] text-text-secondary"
                  title={text}
                >
                  {text}
                </span>
                <time
                  dateTime={e.createdAt}
                  title={new Date(e.createdAt).toLocaleString()}
                  className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint"
                >
                  {formatRelative(e.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );
}

/**
 * Map a note event to its glyph and phrase. A `note_updated` carrying
 * `metadata.restoredFromVersion` renders as a revert with the undo glyph;
 * everything else keeps its already-readable summary under a per-type
 * glyph.
 *
 * @param event - Event to describe.
 * @returns Glyph and phrase for one action row.
 */
function describeNoteEvent(event: NoteActivityEvent): {
  icon: ReactNode;
  text: string;
} {
  const restoredFrom = (
    event.metadata as { restoredFromVersion?: number } | null
  )?.restoredFromVersion;
  if (event.type === "note_updated" && restoredFrom !== undefined) {
    return {
      icon: <IconUndo size={12} />,
      text: `reverted to v${restoredFrom}`,
    };
  }
  switch (event.type) {
    case "note_created":
      return {
        icon: <IconPlus size={12} />,
        text: stripTitle(event, "created note"),
      };
    case "note_updated":
      return { icon: <IconPencil size={12} />, text: phraseUpdate(event) };
    case "note_moved":
      return { icon: <IconSort size={12} />, text: phraseMove(event) };
    case "note_deleted":
      return {
        icon: <IconTrash size={12} />,
        text: stripTitle(event, "moved to trash"),
      };
    case "note_restored":
      return {
        icon: <IconUndo size={12} />,
        text: stripTitle(event, "restored from trash"),
      };
    default:
      return { icon: <IconMore size={12} />, text: event.summary };
  }
}

/**
 * Replace a stored `verbed note "Title"` summary with a short phrase: the
 * panel already sits on the note, so repeating its title per row is noise.
 * Summaries that don't match the stored shape pass through untouched.
 *
 * @param event - Event whose summary to compact.
 * @param phrase - Replacement phrase for the matching summary shape.
 * @returns The compact phrase, or the original summary.
 */
function stripTitle(event: NoteActivityEvent, phrase: string): string {
  return /^\w+ note "/.test(event.summary) ? phrase : event.summary;
}

/**
 * Phrase a plain `note_updated`: name the changed fields from metadata when
 * present (`edited body`, `edited title, tags`), otherwise fall back to the
 * link summaries and the stored text.
 *
 * @param event - The update event.
 * @returns One action phrase.
 */
function phraseUpdate(event: NoteActivityEvent): string {
  if (/^(linked|unlinked) note "/.test(event.summary)) {
    return event.summary.startsWith("linked")
      ? "linked to a task"
      : "unlinked from a task";
  }
  const fields = (event.metadata as { fields?: string[] } | null)?.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    return `edited ${fields.join(", ")}`;
  }
  return stripTitle(event, "edited note");
}

/**
 * Phrase a `note_moved` with its destination folder from metadata.
 *
 * @param event - The move event.
 * @returns One action phrase.
 */
function phraseMove(event: NoteActivityEvent): string {
  const to = (event.metadata as { to?: string } | null)?.to;
  if (typeof to === "string")
    return to === "" ? "moved to root" : `moved to ${to}`;
  return stripTitle(event, "moved note");
}

/**
 * Header label for an actor. Human (web) actors keep their name; agent
 * (MCP) actors render as the owning user's agent.
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

export default NoteHistory;
