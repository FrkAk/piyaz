"use client";

import { useRef, useState } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { EditButton } from "@/components/shared/EditButton";
import { EditHint } from "@/components/shared/EditHint";
import { useInlineEdit } from "@/hooks/useInlineEdit";
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
 * `[[wiki]]` refs); double-click (mouse) or the pencil (touch) enters edit,
 * swapping the whole note to one raw-markdown textarea. Escape or blur
 * commits and returns to the rendered view. Read-only notes never enter
 * edit. Follows the shared inline-edit convention (hover hint + touch
 * pencil). The `[[` picker resolves from data already loaded.
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

  const inlineEdit = useInlineEdit(() => {
    setDraft(body);
    setEditing(true);
  });

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
  };

  if (editing) {
    return (
      <div ref={containerRef} className="prose-spec relative">
        <AutoGrowTextarea
          autoFocus
          value={draft}
          onFocus={inlineEdit.onEditorFocus}
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
      {...inlineEdit.triggerProps}
      className="group/edit relative cursor-text select-text"
    >
      <EditHint />
      <EditButton
        onClick={inlineEdit.onActivate}
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
