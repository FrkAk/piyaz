"use client";

import { useEffect, useRef, useState } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { NoteMarkdown } from "./NoteMarkdown";
import { useWikiAutocomplete } from "./useWikiAutocomplete";

interface NoteEditorProps {
  /** @param body - Raw markdown body, the single source of truth. */
  body: string;
  /** @param editable - When false (locked or placeholder), the note is read-only. */
  editable: boolean;
  /** @param identifier - Owning project identifier for inline task refs. */
  identifier: string;
  /** @param onCommitBody - Commit the edited body on Escape / blur. */
  onCommitBody: (next: string) => void;
}

/**
 * Notes editor: renders the body as full markdown (shared renderer + task /
 * `[[wiki]]` refs); a double-click swaps the whole note to one raw-markdown
 * textarea, entered at the double-clicked block's source line. Escape or
 * blur commits and returns to the rendered view. Read-only notes never
 * enter edit. The `[[` picker resolves from data already loaded.
 *
 * @param props - Body, editability, identifier, and the commit sink.
 * @returns The rendered note, or the raw editor while editing.
 */
export function NoteEditor({
  body,
  editable,
  identifier,
  onCommitBody,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [caret, setCaret] = useState(0);

  const textarea = () =>
    containerRef.current?.querySelector("textarea") ?? null;

  const focusAt = (pos: number) => {
    requestAnimationFrame(() => {
      const el = textarea();
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    if (editing) focusAt(caret);
    // Seed the caret once on entering edit; caret updates during editing must
    // not re-run this or they would fight the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const wiki = useWikiAutocomplete(draft, caret, (next, nextCaret) => {
    setDraft(next);
    setCaret(nextCaret);
    focusAt(nextCaret);
  });

  const enterEdit = (target: HTMLElement) => {
    if (!editable) return;
    if (target.closest("button, a")) return;
    const line = Number(
      target.closest("[data-src-line]")?.getAttribute("data-src-line") ?? "1",
    );
    const offset = body
      .split("\n")
      .slice(0, Math.max(0, line - 1))
      .reduce((n, l) => n + l.length + 1, 0);
    setDraft(body);
    setCaret(offset);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (draft !== body) onCommitBody(draft);
  };

  if (!editing) {
    return (
      <div
        ref={containerRef}
        onDoubleClick={(e) => enterEdit(e.target as HTMLElement)}
      >
        {body.trim() === "" ? (
          <p className="prose-spec text-text-faint">
            {editable ? "Double-click to edit" : "Empty note"}
          </p>
        ) : (
          <NoteMarkdown body={body} identifier={identifier} />
        )}
      </div>
    );
  }

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

export default NoteEditor;
