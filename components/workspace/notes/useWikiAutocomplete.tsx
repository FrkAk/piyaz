"use client";

import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import { type LinkSuggestion, rankLinkSuggestions } from "./link-suggestions";
import { NOTE_TYPE_META, tint } from "./note-meta";
import { NoteLinkContext } from "./NoteInline";

/** Approx line height (px) of the editor textarea, for caret-line placement. */
export const EDITOR_LINE_HEIGHT_PX = 20;

/**
 * The active `[[wiki` query at the caret: the text after the nearest
 * unclosed `[[` on the current line, or `null` when the caret is not inside
 * one.
 *
 * @param value - Full textarea value.
 * @param caret - Caret offset.
 * @returns The partial title query, or `null`.
 */
function wikiQuery(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open === -1) return null;
  const between = before.slice(open + 2);
  if (
    between.includes("]]") ||
    between.includes("[[") ||
    between.includes("\n")
  )
    return null;
  return between;
}

/** Result of {@link useWikiAutocomplete}. */
export interface WikiAutocomplete {
  /** Whether the suggestion popover is open. */
  open: boolean;
  /** The popover node to render inside the editor's relative container. */
  popover: ReactNode;
  /**
   * Handle a textarea keydown. Returns `true` when the popover consumed it
   * (arrow / enter / tab / escape while open) so the caller skips its own
   * handling.
   */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * `[[` link autocomplete for the whole-note editor textarea. Builds a
 * ranked notes + tasks candidate list from the workspace `NoteLinkContext`,
 * renders a caret-line-anchored popover, and inserts the picked link at the
 * caret. Adds no fetch — resolves from data already loaded.
 *
 * @param value - Current textarea value.
 * @param caret - Current caret offset.
 * @param onInsert - Apply a picked insertion: new value and new caret.
 * @returns The open flag, the popover node, and a keydown handler.
 */
export function useWikiAutocomplete(
  value: string,
  caret: number,
  onInsert: (nextValue: string, nextCaret: number) => void,
): WikiAutocomplete {
  const ctx = useContext(NoteLinkContext);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  const query = ctx === null ? null : wikiQuery(value, caret);

  const candidates = useMemo<LinkSuggestion[]>(() => {
    if (ctx === null) return [];
    const list: LinkSuggestion[] = [];
    for (const note of ctx.notesByTitle.values()) {
      if (note.title.trim() === "") continue;
      list.push({
        id: `note-${note.id}`,
        title: note.title,
        insert: `[[${note.title}]]`,
        color: NOTE_TYPE_META[note.type].color,
        hint: NOTE_TYPE_META[note.type].label,
      });
    }
    for (const [seq, task] of ctx.tasksBySeq) {
      list.push({
        id: `task-${task.taskId}`,
        title: task.title,
        insert: `[[${ctx.identifier}-${seq}]]`,
        color: STATUS_META[task.status].cssVar,
        hint: `${ctx.identifier}-${seq}`,
      });
    }
    return list;
  }, [ctx]);

  const matches = useMemo<LinkSuggestion[]>(() => {
    if (query === null || dismissed) return [];
    return rankLinkSuggestions(query, candidates);
  }, [candidates, query, dismissed]);

  const open = matches.length > 0;
  const activeIdx = Math.min(active, matches.length - 1);

  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setActive(0);
    setDismissed(false);
  }

  const insert = (text: string) => {
    const openIdx = value.slice(0, caret).lastIndexOf("[[");
    if (openIdx === -1) return;
    const tail = value.slice(caret).replace(/^\]\]/, "");
    const next = `${value.slice(0, openIdx)}${text}${tail}`;
    setDismissed(true);
    onInsert(next, openIdx + text.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (a + 1) % matches.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insert(matches[activeIdx].insert);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  };

  const caretTop =
    value.slice(0, caret).split("\n").length * EDITOR_LINE_HEIGHT_PX + 4;
  const popover = open ? (
    <WikiSuggestions
      matches={matches}
      active={activeIdx}
      top={caretTop}
      onPick={insert}
    />
  ) : null;

  return { open, popover, onKeyDown };
}

interface WikiSuggestionsProps {
  /** @param matches - Ranked note and task suggestions. */
  matches: LinkSuggestion[];
  /** @param active - Highlighted index. */
  active: number;
  /** @param top - Popover top offset (px), anchored to the caret line. */
  top: number;
  /** @param onPick - Insert the picked suggestion's link text. */
  onPick: (text: string) => void;
}

/**
 * Dropdown of note and task suggestions for the open `[[` query. Picks fire
 * on `mousedown` with `preventDefault` so the textarea keeps focus.
 *
 * @param props - Matches, highlight, position, and pick handler.
 * @returns The suggestion popover.
 */
function WikiSuggestions({
  matches,
  active,
  top,
  onPick,
}: WikiSuggestionsProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      className="absolute left-0 z-20 max-h-56 w-64 overflow-y-auto rounded-md border border-border py-1 shadow-[var(--shadow-float)]"
      style={{ top, background: "var(--color-surface)" }}
    >
      {matches.map((match, i) => (
        <button
          key={match.id}
          ref={i === active ? activeRef : null}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(match.insert);
          }}
          className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-left text-[12.5px]"
          style={{
            background: i === active ? tint(match.color, 10) : "transparent",
            color: "var(--color-text-secondary)",
          }}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: match.color }}
          />
          <span className="min-w-0 flex-1 truncate">{match.title}</span>
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-text-faint">
            {match.hint}
          </span>
        </button>
      ))}
    </div>
  );
}
