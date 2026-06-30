"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { Checkbox } from "@/components/shared/Checkbox";
import { Markdown } from "@/components/shared/Markdown";
import { EditButton } from "@/components/shared/EditButton";
import { useInlineEdit } from "@/hooks/useInlineEdit";
import { useUndo, UndoButton } from "@/hooks/useUndo";
import { updateTask } from "@/lib/graph/mutations";
import { IconPlus, IconTrash } from "@/components/shared/icons";
import type { AcceptanceCriterion } from "@/lib/types";
import { SectionHeader } from "./SectionHeader";

/**
 * Hash criteria into a stable string so reference-changing prop updates
 * with identical content don't trigger a sync that would wipe optimistic
 * edits in flight.
 *
 * @param items - Criteria to hash.
 * @returns Pipe-joined `<checked>|<text>` signature.
 */
function signatureFor(items: AcceptanceCriterion[] | undefined | null): string {
  return (items ?? []).map((c) => `${c.checked}|${c.text}`).join("||");
}

interface CriteriaSectionProps {
  /** Task UUID. */
  taskId: string;
  /** Acceptance criteria from the graph. */
  criteria: AcceptanceCriterion[] | undefined | null;
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
}

/**
 * Acceptance-criteria checklist with optimistic toggles, inline rename,
 * delete-with-undo, and inline-add. The local-state suppression after a
 * mutation prevents stale SSE refreshes from flickering checkmarks.
 *
 * @param props - Section configuration.
 * @returns Checklist plus add affordance.
 */
export function CriteriaSection({
  taskId,
  criteria,
  onGraphChange,
}: CriteriaSectionProps) {
  const [local, setLocal] = useState(() => criteria ?? []);
  const [syncedSig, setSyncedSig] = useState(() => signatureFor(criteria));
  const [prevTaskId, setPrevTaskId] = useState(taskId);
  const [suppressing, setSuppressing] = useState(false);
  const localRef = useRef(local);
  const suppressTimerRef = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    localRef.current = local;
  }, [local]);
  useEffect(
    () => () => {
      if (suppressTimerRef.current !== null)
        window.clearTimeout(suppressTimerRef.current);
    },
    [],
  );

  /**
   * Mark a 1-second window where incoming SSE refreshes should not
   * clobber the optimistic local state we just wrote.
   */
  const markMutation = () => {
    setSuppressing(true);
    if (suppressTimerRef.current !== null)
      window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => {
      setSuppressing(false);
      suppressTimerRef.current = null;
    }, 1000);
  };

  const incomingSig = signatureFor(criteria);
  if (!suppressing && incomingSig !== syncedSig) {
    setSyncedSig(incomingSig);
    setLocal(criteria ?? []);
  }

  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId);
    setEditingId(null);
    setAdding(false);
  }

  const handleToggle = useCallback(
    async (id: string) => {
      const prev = localRef.current;
      const next = prev.map((c) =>
        c.id === id ? { ...c, checked: !c.checked } : c,
      );
      setLocal(next);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { acceptanceCriteria: next }, true);
      } catch {
        setLocal(prev);
        setSaveError("Couldn't save changes. Try again in a moment.");
      }
    },
    [taskId],
  );

  const handleRename = useCallback(
    async (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const target = localRef.current.find((c) => c.id === id);
      if (target && trimmed === target.text) {
        setEditingId(null);
        return;
      }
      const prev = localRef.current;
      const next = prev.map((c) => (c.id === id ? { ...c, text: trimmed } : c));
      setLocal(next);
      setEditingId(null);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { acceptanceCriteria: next }, true);
      } catch {
        setLocal(prev);
        setSaveError("Couldn't save changes. Try again in a moment.");
      }
    },
    [taskId],
  );

  const handleRestore = useCallback(
    async (item: { criterion: AcceptanceCriterion; index: number }) => {
      const prev = localRef.current;
      const next = [...prev];
      next.splice(item.index, 0, item.criterion);
      setLocal(next);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { acceptanceCriteria: next }, true);
      } catch (err) {
        // Revert the optimistic insert and rethrow so useUndo re-pushes the
        // item — the entry stays recoverable instead of vanishing.
        setLocal(prev);
        setSaveError("Couldn't undo. Try again in a moment.");
        throw err;
      }
    },
    [taskId],
  );

  const {
    canUndo,
    push: pushUndo,
    undo,
  } = useUndo<{ criterion: AcceptanceCriterion; index: number }>({
    onUndo: handleRestore,
    resetOn: taskId,
    keyboard: true,
  });

  const handleDelete = useCallback(
    async (id: string) => {
      const prev = localRef.current;
      const index = prev.findIndex((c) => c.id === id);
      if (index === -1) return;
      const removed = prev[index];
      const next = prev.filter((c) => c.id !== id);
      setLocal(next);
      setEditingId(null);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { acceptanceCriteria: next }, true);
        pushUndo({ criterion: removed, index });
      } catch {
        setLocal(prev);
        setSaveError("Couldn't delete. Try again in a moment.");
      }
    },
    [taskId, pushUndo],
  );

  const handleAdd = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setAdding(false);
        return;
      }
      const newCriterion: AcceptanceCriterion = {
        id: crypto.randomUUID(),
        text: trimmed,
        checked: false,
      };
      const prev = localRef.current;
      const next = [...prev, newCriterion];
      setLocal(next);
      setAdding(false);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { acceptanceCriteria: next }, true);
        onGraphChange?.();
      } catch {
        setLocal(prev);
        setSaveError("Couldn't add the criterion. Try again in a moment.");
      }
    },
    [taskId, onGraphChange],
  );

  const totalCount = local.length;
  const doneCount = local.filter((c) => c.checked).length;

  return (
    <section className="mb-7">
      <SectionHeader
        label="Acceptance criteria"
        count={totalCount > 0 ? `${doneCount} / ${totalCount}` : undefined}
        trailing={
          <span className="flex items-center gap-1.5">
            <UndoButton canUndo={canUndo} onUndo={undo} />
            {!adding && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
                aria-label="Add criterion"
              >
                <IconPlus size={10} />
                Add
              </button>
            )}
          </span>
        }
      />
      {saveError && <p className="mb-2 text-[11px] text-danger">{saveError}</p>}
      <div className="space-y-1.5">
        {local.map((c) => (
          <CriterionRow
            key={c.id}
            criterion={c}
            editing={editingId === c.id}
            onToggle={() => handleToggle(c.id)}
            onStartEdit={() => setEditingId(c.id)}
            onCommit={(text) => handleRename(c.id, text)}
            onCancel={() => {
              cancelRef.current = false;
              setEditingId(null);
            }}
            onDelete={() => handleDelete(c.id)}
            cancelRef={cancelRef}
          />
        ))}
      </div>

      {adding && (
        <CriterionAddForm
          onSubmit={(text) => void handleAdd(text)}
          onCancel={() => setAdding(false)}
        />
      )}
    </section>
  );
}

interface CriterionAddFormProps {
  /** Commit a new criterion. */
  onSubmit: (text: string) => void;
  /** Dismiss without saving. */
  onCancel: () => void;
}

/**
 * Card-style add form sharing the Relationships add-form aesthetic — bordered
 * container, focused input, and accent / ghost chip buttons. Pressing Enter
 * commits, Esc cancels.
 *
 * @param props - Form configuration.
 * @returns Form element.
 */
function CriterionAddForm({ onSubmit, onCancel }: CriterionAddFormProps) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface-raised/40">
      <div className="space-y-2 p-3">
        <AutoGrowTextarea
          autoFocus
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="What needs to be true for this task to be done?"
          className="w-full resize-none rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="cursor-pointer rounded-md border border-accent/30 bg-accent/15 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-light transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface CriterionRowProps {
  /** Criterion data. */
  criterion: AcceptanceCriterion;
  /** Whether this row is in edit mode. */
  editing: boolean;
  /** Toggle the checkbox. */
  onToggle: () => void;
  /** Switch to edit mode. */
  onStartEdit: () => void;
  /** Commit the new text. */
  onCommit: (text: string) => void;
  /** Cancel without saving. */
  onCancel: () => void;
  /** Delete the criterion. */
  onDelete: () => void;
  /** Shared cancel flag — toggled true on Esc to skip the blur-save path. */
  cancelRef: React.MutableRefObject<boolean>;
}

/**
 * Individual criterion row — checkbox + body + trailing delete.
 *
 * @param props - Row configuration.
 * @returns Row element.
 */
function CriterionRow({
  criterion,
  editing,
  onToggle,
  onStartEdit,
  onCommit,
  onCancel,
  onDelete,
  cancelRef,
}: CriterionRowProps) {
  const edit = useInlineEdit(onStartEdit);
  return (
    <div className="group/criterion flex items-start gap-2.5 rounded-md border border-border bg-surface-raised/40 px-3 py-2 transition-colors">
      <Checkbox
        checked={criterion.checked}
        onChange={onToggle}
        className="!min-h-0 mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <AutoGrowTextarea
            defaultValue={criterion.text}
            autoFocus
            rows={1}
            onFocus={edit.onEditorFocus}
            onBlur={(e) => {
              if (cancelRef.current) {
                cancelRef.current = false;
                onCancel();
              } else onCommit(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                cancelRef.current = true;
                e.currentTarget.blur();
              }
            }}
            className="w-full resize-none rounded-md border border-border-strong bg-surface px-2 py-1 text-[13px] text-text-primary outline-none transition-colors focus:border-accent"
          />
        ) : (
          <div
            {...edit.triggerProps}
            className={`cursor-text select-text rounded-md text-[13px] leading-snug transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 ${
              criterion.checked
                ? "text-text-muted line-through"
                : "text-text-secondary"
            }`}
          >
            <Markdown>{criterion.text}</Markdown>
          </div>
        )}
      </div>
      {!editing && (
        <EditButton
          onClick={edit.onActivate}
          label="Edit criterion"
          className="self-center"
        />
      )}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete criterion"
        className="shrink-0 self-center cursor-pointer rounded p-1 text-text-muted opacity-0 transition-all hover:text-danger group-hover/criterion:opacity-100 pointer-coarse:opacity-100"
      >
        <IconTrash size={11} />
      </button>
    </div>
  );
}

export default CriteriaSection;
