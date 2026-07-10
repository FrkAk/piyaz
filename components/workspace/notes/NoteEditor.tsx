"use client";

import { useEffect, useRef, useState } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { EditButton } from "@/components/shared/EditButton";
import { EditHint } from "@/components/shared/EditHint";
import { NoteMarkdown } from "./NoteMarkdown";
import {
  EDITOR_LINE_HEIGHT_PX,
  useWikiAutocomplete,
} from "./useWikiAutocomplete";

/**
 * Nearest scrollable ancestor of an element, or null.
 *
 * @param el - Starting element.
 * @returns The first ancestor that scrolls vertically, or null.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (
      (oy === "auto" || oy === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      return node;
    node = node.parentElement;
  }
  return null;
}

interface NoteEditorProps {
  /** @param body - Raw markdown body, the single source of truth. */
  body: string;
  /** @param editable - When false (locked or placeholder), the note is read-only. */
  editable: boolean;
  /** @param identifier - Owning project identifier for inline task refs. */
  identifier: string;
  /** @param onCommitBody - Commit the edited body on Escape / blur. */
  onCommitBody: (next: string) => void;
  /**
   * @param onEditingChange - Edit-session boundary: `true` when the raw
   *   textarea opens, `false` after commit. Called after `onCommitBody`
   *   on the changed path, so an exit with buffered content keeps the
   *   autosave dirty gate held while a no-op exit releases it.
   */
  onEditingChange?: (editing: boolean) => void;
}

/**
 * Notes editor: renders the body as full markdown (shared renderer + task /
 * `[[wiki]]` refs); double-click (mouse) or the pencil (touch) enters edit,
 * swapping the whole note to one raw-markdown textarea with the caret at the
 * clicked block's source line. Escape or blur commits and returns to the
 * rendered view. Read-only notes never enter edit. The `[[` picker resolves
 * from data already loaded.
 *
 * @param props - Body, editability, identifier, and the commit sink.
 * @returns The rendered note, or the raw editor while editing.
 */
export function NoteEditor({
  body,
  editable,
  identifier,
  onCommitBody,
  onEditingChange,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clickYRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [caret, setCaret] = useState(0);
  const [entryCaret, setEntryCaret] = useState(0);

  /** Character offset of the start of a 1-based source line. */
  const offsetForLine = (line: number) =>
    body
      .split("\n")
      .slice(0, Math.max(0, line - 1))
      .reduce((n, l) => n + l.length + 1, 0);

  const beginEdit = (offset: number) => {
    setDraft(body);
    setEntryCaret(offset);
    setEditing(true);
    onEditingChange?.(true);
  };

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector("textarea");
      if (!el) return;
      // Focus without the browser scrolling the tall textarea's top into
      // view (which would jump the page to the note's beginning).
      el.focus({ preventScroll: true });
      el.setSelectionRange(entryCaret, entryCaret);
      setCaret(entryCaret);
      // Keep the clicked line where the user clicked it: scroll the pane so
      // the caret line sits at the double-click's viewport Y.
      const clickY = clickYRef.current;
      clickYRef.current = null;
      if (clickY === null) return;
      const lineIdx = body.slice(0, entryCaret).split("\n").length - 1;
      const caretY =
        el.getBoundingClientRect().top + lineIdx * EDITOR_LINE_HEIGHT_PX;
      const pane = scrollParent(el);
      if (pane) pane.scrollTop += caretY - clickY;
    });
    // Seed the caret once on entering edit; later caret updates must not
    // re-run this or they would fight the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const wiki = useWikiAutocomplete(draft, caret, (next, nextCaret) => {
    setDraft(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector("textarea");
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  });

  const commit = () => {
    setEditing(false);
    if (draft !== body) onCommitBody(draft);
    onEditingChange?.(false);
  };

  if (editing) {
    return (
      <div ref={containerRef} className="prose-spec relative">
        <AutoGrowTextarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (wiki.onKeyDown(e)) return;
            if (e.key === "Escape") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          className="block w-full bg-transparent outline-none"
          style={{
            fontFamily: "inherit",
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "var(--color-text-secondary)",
            caretColor: "var(--color-accent)",
            resize: "none",
            border: "none",
            padding: 0,
            maxHeight: 100000,
          }}
        />
        {wiki.popover}
      </div>
    );
  }

  if (!editable) {
    return body.trim() === "" ? (
      <p className="prose-spec text-[13.5px] text-text-faint">Empty note</p>
    ) : (
      <NoteMarkdown body={body} identifier={identifier} />
    );
  }

  return (
    <div
      tabIndex={0}
      title="Double-click to edit"
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, a")) return;
        const line = Number(
          target.closest("[data-src-line]")?.getAttribute("data-src-line") ??
            "1",
        );
        clickYRef.current = e.clientY;
        beginEdit(offsetForLine(line));
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          beginEdit(body.length);
        }
      }}
      className="group/edit relative cursor-text select-text outline-none"
    >
      <EditHint />
      <EditButton
        onClick={() => beginEdit(body.length)}
        label="Edit note"
        className="absolute right-0 top-0 z-10 bg-base/80"
      />
      {body.trim() === "" ? (
        <p className="prose-spec text-[13.5px] italic text-text-faint">
          Double-click to edit…
        </p>
      ) : (
        <NoteMarkdown body={body} identifier={identifier} />
      )}
    </div>
  );
}

export default NoteEditor;
