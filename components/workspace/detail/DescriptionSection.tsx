"use client";

import { useState, useRef, useCallback } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { Markdown } from "@/components/shared/Markdown";
import { updateTask } from "@/lib/graph/mutations";
import { SectionHeader } from "./SectionHeader";

interface DescriptionSectionProps {
  /** Task UUID. */
  taskId: string;
  /** Current description (markdown). */
  description: string;
  /** Refresh the graph on save. */
  onGraphChange?: () => void;
}

/**
 * Click-to-edit description section. Saves on blur, restores on Esc, and
 * skips writes when the value is unchanged.
 *
 * @param props - Section configuration.
 * @returns Section with markdown body or auto-grow textarea.
 */
export function DescriptionSection({
  taskId,
  description,
  onGraphChange,
}: DescriptionSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description);
  const [prevDescription, setPrevDescription] = useState(description);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  if (description !== prevDescription) {
    setPrevDescription(description);
    setDraft(description);
  }

  const handleSave = useCallback(async () => {
    setEditing(false);
    if (draft !== description) {
      try {
        setSaveError(null);
        await updateTask(taskId, { description: draft });
        onGraphChange?.();
      } catch {
        // Server actions mask error details in production; reopen the editor
        // with the draft intact so the user's text is not silently dropped.
        setSaveError("Couldn't save the description. Try again in a moment.");
        setEditing(true);
      }
    }
  }, [draft, description, taskId, onGraphChange]);

  return (
    <section className="mb-7">
      <SectionHeader label="Description" />
      {saveError && <p className="mb-2 text-[11px] text-danger">{saveError}</p>}
      {editing ? (
        <AutoGrowTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (cancelRef.current) {
              cancelRef.current = false;
              setDraft(description);
              setEditing(false);
            } else {
              void handleSave();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              cancelRef.current = true;
              e.currentTarget.blur();
            }
          }}
          autoFocus
          rows={3}
          className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13.5px] text-text-primary outline-none transition-colors focus:border-accent"
        />
      ) : (
        <div
          onClick={() => setEditing(true)}
          className="group/edit relative cursor-text rounded-md border border-transparent px-3 py-2 transition-all hover:border-border hover:bg-surface/40"
        >
          {description ? (
            <Markdown className="text-[13.5px] leading-relaxed text-text-secondary">
              {description}
            </Markdown>
          ) : (
            <p className="text-[13.5px] italic text-text-muted">
              Click to add a description…
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default DescriptionSection;
