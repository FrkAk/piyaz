"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AutoGrowTextarea } from "@/components/shared/AutoGrowTextarea";
import { Avatar } from "@/components/shared/Avatar";
import { Markdown } from "@/components/shared/Markdown";
import { EditButton } from "@/components/shared/EditButton";
import { useInlineEdit } from "@/hooks/useInlineEdit";
import { useUndo, UndoButton } from "@/hooks/useUndo";
import { updateTask } from "@/lib/graph/mutations";
import { IconPlus, IconTrash } from "@/components/shared/icons";
import type { Decision } from "@/lib/types";
import { SectionHeader } from "@/components/shared/SectionHeader";

/** Map a decision source to a display author (`user` vs `agent`). */
const SOURCE_AUTHOR: Record<
  Decision["source"],
  { name: string; isAgent: boolean }
> = {
  brainstorm: { name: "user", isAgent: false },
  refinement: { name: "user", isAgent: false },
  planning: { name: "agent", isAgent: true },
  execution: { name: "agent", isAgent: true },
};

/**
 * Compute a stable signature for a decisions list — body text alone is
 * enough to detect prop content changes vs reference churn.
 *
 * @param items - Decisions to hash.
 * @returns Pipe-joined text signature.
 */
function signatureFor(items: Decision[] | undefined | null): string {
  return (items ?? []).map((d) => d.text).join("||");
}

interface DecisionsSectionProps {
  /** Task UUID. */
  taskId: string;
  /** Decisions from the graph. */
  decisions: Decision[] | undefined | null;
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
}

/**
 * Decisions list — same inline-edit / undo pattern as criteria, with a
 * left-accent strip per entry to call out the trail of choices.
 *
 * @param props - Section configuration.
 * @returns Decisions list plus add affordance.
 */
export function DecisionsSection({
  taskId,
  decisions,
  onGraphChange,
}: DecisionsSectionProps) {
  const [local, setLocal] = useState(() => decisions ?? []);
  const [syncedSig, setSyncedSig] = useState(() => signatureFor(decisions));
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
   * Mark a 1-second window where SSE refreshes won't clobber the
   * optimistic local state.
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

  const incomingSig = signatureFor(decisions);
  if (!suppressing && incomingSig !== syncedSig) {
    setSyncedSig(incomingSig);
    setLocal(decisions ?? []);
  }

  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId);
    setEditingId(null);
    setAdding(false);
  }

  const handleRename = useCallback(
    async (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const target = localRef.current.find((d) => d.id === id);
      if (target && trimmed === target.text) {
        setEditingId(null);
        return;
      }
      const prev = localRef.current;
      const next = prev.map((d) => (d.id === id ? { ...d, text: trimmed } : d));
      setLocal(next);
      setEditingId(null);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { decisions: next }, true);
      } catch {
        setLocal(prev);
        setSaveError("Couldn't save changes. Try again in a moment.");
      }
    },
    [taskId],
  );

  const handleRestore = useCallback(
    async (item: { decision: Decision; index: number }) => {
      const prev = localRef.current;
      const next = [...prev];
      next.splice(item.index, 0, item.decision);
      setLocal(next);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { decisions: next }, true);
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
  } = useUndo<{ decision: Decision; index: number }>({
    onUndo: handleRestore,
    resetOn: taskId,
  });

  const handleDelete = useCallback(
    async (id: string) => {
      const prev = localRef.current;
      const index = prev.findIndex((d) => d.id === id);
      if (index === -1) return;
      const removed = prev[index];
      const next = prev.filter((d) => d.id !== id);
      setLocal(next);
      setEditingId(null);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { decisions: next }, true);
        pushUndo({ decision: removed, index });
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
      const newDecision: Decision = {
        id: crypto.randomUUID(),
        text: trimmed,
        date: new Date().toISOString().slice(0, 10),
        source: "refinement",
      };
      const prev = localRef.current;
      const next = [...prev, newDecision];
      setLocal(next);
      setAdding(false);
      setSaveError(null);
      markMutation();
      try {
        await updateTask(taskId, { decisions: next }, true);
        onGraphChange?.();
      } catch {
        setLocal(prev);
        setSaveError("Couldn't add the decision. Try again in a moment.");
      }
    },
    [taskId, onGraphChange],
  );

  return (
    <section className="mb-7">
      <SectionHeader
        label="Decisions"
        count={local.length > 0 ? local.length : undefined}
        trailing={
          <span className="flex items-center gap-1.5">
            <UndoButton canUndo={canUndo} onUndo={undo} />
            {!adding && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
                aria-label="Add decision"
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
        {local.map((d) => (
          <DecisionCard
            key={d.id}
            decision={d}
            editing={editingId === d.id}
            onStartEdit={() => setEditingId(d.id)}
            onCommit={(text) => handleRename(d.id, text)}
            onCancel={() => {
              cancelRef.current = false;
              setEditingId(null);
            }}
            onDelete={() => handleDelete(d.id)}
            cancelRef={cancelRef}
          />
        ))}
      </div>

      {adding && (
        <DecisionAddForm
          onSubmit={(text) => void handleAdd(text)}
          onCancel={() => setAdding(false)}
        />
      )}
    </section>
  );
}

interface DecisionAddFormProps {
  /** Commit a new decision body. */
  onSubmit: (text: string) => void;
  /** Dismiss without saving. */
  onCancel: () => void;
}

/**
 * Card-style add form sharing the Relationships add-form aesthetic — bordered
 * container with focused textarea and accent / ghost chip buttons. Pressing
 * Enter commits, Esc cancels.
 *
 * @param props - Form configuration.
 * @returns Form element.
 */
function DecisionAddForm({ onSubmit, onCancel }: DecisionAddFormProps) {
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
          placeholder="What did you decide, and why?"
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

interface DecisionCardProps {
  /** Decision data. */
  decision: Decision;
  /** Whether this card is in edit mode. */
  editing: boolean;
  /** Switch to edit mode. */
  onStartEdit: () => void;
  /** Commit a new body text. */
  onCommit: (text: string) => void;
  /** Cancel without saving. */
  onCancel: () => void;
  /** Delete the decision. */
  onDelete: () => void;
  /** Shared cancel flag toggled true on Esc. */
  cancelRef: React.MutableRefObject<boolean>;
}

/**
 * Decision card with accent left strip — surfaces the source and date.
 *
 * @param props - Card configuration.
 * @returns Card element.
 */
function DecisionCard({
  decision,
  editing,
  onStartEdit,
  onCommit,
  onCancel,
  onDelete,
  cancelRef,
}: DecisionCardProps) {
  const author = SOURCE_AUTHOR[decision.source] ?? SOURCE_AUTHOR.refinement;
  const edit = useInlineEdit(onStartEdit);
  return (
    <div
      className="group/decision rounded-lg border border-border bg-surface-raised/40 py-3 px-3.5 transition-colors"
      style={{ borderLeft: "2px solid var(--color-accent)" }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Avatar name={author.name} size={16} accent={author.isAgent} />
        <span className="text-[12px] font-medium text-text-primary">
          {author.isAgent
            ? `agent: ${decision.source}`
            : `user: ${decision.source}`}
        </span>
        <span className="text-text-faint">·</span>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">
          {decision.date}
        </span>
        <span className="flex-1" />
        <span className="rounded border border-accent/20 bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-accent-light">
          {decision.source}
        </span>
        {!editing && (
          <EditButton onClick={edit.onActivate} label="Edit decision" />
        )}
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete decision"
          className="shrink-0 cursor-pointer rounded p-1 text-text-muted opacity-0 transition-all hover:text-danger group-hover/decision:opacity-100 pointer-coarse:opacity-100"
        >
          <IconTrash size={11} />
        </button>
      </div>
      {editing ? (
        <AutoGrowTextarea
          defaultValue={decision.text}
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
          className="cursor-text select-text rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <Markdown className="text-[12.5px] leading-snug text-text-secondary">
            {decision.text}
          </Markdown>
        </div>
      )}
    </div>
  );
}

export default DecisionsSection;
