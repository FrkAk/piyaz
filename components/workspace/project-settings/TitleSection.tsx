"use client";

import { useCallback, useRef, useState } from "react";
import { updateProjectSettings } from "@/lib/actions/project";
import {
  caretOffsetFromPoint,
  placeCaret,
} from "@/components/shared/inlineEdit";

interface TitleSectionProps {
  projectId: string;
  initialTitle: string;
  onUpdated?: () => void;
}

const SECTION_LABEL_CLASS =
  "font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted";

/**
 * Click-to-edit title input that persists on blur.
 * @param props - Section props.
 * @returns Title row.
 */
export function TitleSection({
  projectId,
  initialTitle,
  onUpdated,
}: TitleSectionProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialTitle);
  const [syncedInitialTitle, setSyncedInitialTitle] = useState(initialTitle);
  const [serverError, setServerError] = useState<string | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  if (initialTitle !== syncedInitialTitle && !editing) {
    setSyncedInitialTitle(initialTitle);
    setValue(initialTitle);
  }

  /**
   * Persist the trimmed title if it changed; revert on empty input.
   * @returns Resolves once the server action completes.
   */
  const commit = useCallback(async () => {
    setEditing(false);
    const trimmed = value.trim();
    if (!trimmed) {
      setValue(initialTitle);
      setServerError(null);
      return;
    }
    if (trimmed === initialTitle) {
      setServerError(null);
      return;
    }
    setServerError(null);
    const result = await updateProjectSettings(projectId, { title: trimmed });
    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    onUpdated?.();
  }, [value, initialTitle, projectId, onUpdated]);

  return (
    <section className="space-y-1.5">
      <label className={SECTION_LABEL_CLASS}>Title</label>
      {editing ? (
        <input
          type="text"
          value={value}
          onFocus={(e) => {
            placeCaret(e.currentTarget, pendingCaretRef.current);
            pendingCaretRef.current = null;
          }}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setValue(initialTitle);
              setServerError(null);
              setEditing(false);
            }
          }}
          autoFocus
          className="w-full rounded-lg border border-border-strong bg-base px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={(e) => {
            pendingCaretRef.current = caretOffsetFromPoint(
              e.currentTarget,
              e.clientX,
              e.clientY,
            );
            setEditing(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditing(true);
            }
          }}
          title="Double-click to edit"
          className="w-full cursor-text rounded-lg border border-transparent px-3 py-2 text-left text-sm text-text-primary transition-colors hover:border-border hover:bg-surface-hover/40"
        >
          {value || <span className="text-text-muted">Untitled</span>}
        </button>
      )}
      {serverError && (
        <p className="font-mono text-[10px] text-danger">{serverError}</p>
      )}
    </section>
  );
}
