"use client";

import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/shared/Button";
import { CopyButton } from "@/components/shared/CopyButton";
import { Markdown } from "@/components/shared/Markdown";
import { useUndo, UndoButton } from "@/hooks/useUndo";
import { updateTask } from "@/lib/graph/mutations";
import type { TaskEdge } from "@/lib/db/schema";
import { SectionHeader } from "@/components/shared/SectionHeader";

/** Lifecycle action types — match the PlanTab undo identifiers. */
type LifecycleAction = "plan-saved" | "start-impl" | "mark-done";

interface PlanSectionProps {
  /** Task UUID. */
  taskId: string;
  /** Current task status — drives which phase renders. */
  status: string;
  /** Pre-built planning context to copy into the agent. */
  planningContext: string;
  /** Saved implementation plan, or null. */
  existingPlan: string | null;
  /** Saved execution record, or null. */
  existingExecution: string | null;
  /** All edges connected to this task — used to surface unmet upstreams. */
  edges?: TaskEdge[];
  /** Map of every task in the project for the unmet-deps preview. */
  taskMap?: Map<string, { title: string; status: string; taskRef: string }>;
  /** Refresh the graph after a status transition. */
  onGraphChange?: () => void;
}

/**
 * Plan section — folds the existing PlanTab lifecycle bridge into a
 * scrollable detail section. Renders one of three states: paste plan
 * (draft), start implementation (planned), or record execution
 * (in_progress); shows the saved plan + execution record when done.
 *
 * @param props - Section configuration.
 * @returns Plan section content keyed off the current status.
 */
export function PlanSection({
  taskId,
  status,
  planningContext,
  existingPlan,
  existingExecution,
  edges = [],
  taskMap,
  onGraphChange,
}: PlanSectionProps) {
  const [plan, setPlan] = useState(existingPlan);
  const [execution, setExecution] = useState(existingExecution);
  const [planInput, setPlanInput] = useState("");
  const [executionInput, setExecutionInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const started = status === "in_progress" || status === "done";

  const handleUndoAction = useCallback(
    async (action: LifecycleAction) => {
      setSaving(true);
      setSaveError(null);
      try {
        if (action === "plan-saved") {
          await updateTask(taskId, {
            implementationPlan: null,
            status: "draft",
          });
          setPlan(null);
          setPlanInput("");
        } else if (action === "start-impl") {
          await updateTask(taskId, { status: "planned" });
        } else {
          await updateTask(taskId, {
            executionRecord: null,
            status: "in_progress",
          });
          setExecution(null);
        }
        onGraphChange?.();
      } catch (err) {
        // Rethrow so useUndo re-pushes the lifecycle entry.
        setSaveError("Couldn't undo. Try again in a moment.");
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [taskId, onGraphChange],
  );

  const {
    canUndo,
    push: pushUndo,
    undo,
  } = useUndo<LifecycleAction>({ onUndo: handleUndoAction, resetOn: taskId });

  const unmetDeps = useMemo(() => {
    if (!taskMap) return [] as { id: string; title: string; taskRef: string }[];
    return edges
      .filter((e) => e.sourceTaskId === taskId && e.edgeType === "depends_on")
      .map((e) => {
        const info = taskMap.get(e.targetTaskId);
        return info && info.status !== "done" && info.status !== "cancelled"
          ? { id: e.targetTaskId, title: info.title, taskRef: info.taskRef }
          : null;
      })
      .filter(
        (d): d is { id: string; title: string; taskRef: string } => d !== null,
      );
  }, [edges, taskId, taskMap]);

  const handleSavePlan = useCallback(async () => {
    const trimmed = planInput.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateTask(taskId, {
        implementationPlan: trimmed,
        status: "planned",
      });
      setPlan(trimmed);
      pushUndo("plan-saved");
      onGraphChange?.();
    } catch {
      setSaveError("Couldn't save the plan. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [taskId, planInput, pushUndo, onGraphChange]);

  const handleStartImpl = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateTask(taskId, { status: "in_progress" });
      pushUndo("start-impl");
      onGraphChange?.();
    } catch {
      setSaveError("Couldn't update the status. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [taskId, pushUndo, onGraphChange]);

  const handleMarkDone = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const record = executionInput.trim() || "Completed";
    try {
      await updateTask(taskId, { executionRecord: record, status: "done" });
      setExecution(record);
      pushUndo("mark-done");
      onGraphChange?.();
    } catch {
      setSaveError("Couldn't mark the task done. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [taskId, executionInput, pushUndo, onGraphChange]);

  const handleReplan = useCallback(() => {
    setPlan(null);
    setPlanInput("");
  }, []);

  if (!plan) {
    return (
      <section className="mb-7">
        <SectionHeader
          label="Plan"
          badge={<PhaseBadge label="Draft" tone="draft" />}
        />
        {saveError && (
          <p className="mb-2 text-[11px] text-danger">{saveError}</p>
        )}
        <div className="space-y-3 rounded-md border border-border bg-surface-raised/40 p-3">
          <p className="text-[12.5px] text-text-secondary">
            Copy the planning context into your CLI agent (Claude Code, Cursor,
            Codex, …), then paste the implementation plan back here.
          </p>

          {unmetDeps.length > 0 && <UnmetDepsHint deps={unmetDeps} />}

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                1. Copy planning context
              </span>
              <span className="flex-1" />
              <CopyButton text={planningContext} label="Copy" />
            </div>
            <Markdown className="rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
              {planningContext}
            </Markdown>
          </div>

          <div>
            <span className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              2. Paste the implementation plan
            </span>
            <textarea
              value={planInput}
              onChange={(e) => setPlanInput(e.target.value)}
              placeholder="Paste your coding agent's implementation plan here…"
              rows={8}
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-[11.5px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent"
            />
            <Button
              variant="primary"
              size="sm"
              className="mt-2"
              disabled={!planInput.trim() || saving}
              onClick={handleSavePlan}
            >
              {saving ? "Saving…" : "Save plan & mark planned"}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-7">
      <SectionHeader
        label="Plan"
        badge={
          <PhaseBadge
            label={execution ? "Done" : started ? "In progress" : "Planned"}
            tone={execution ? "done" : started ? "progress" : "planned"}
          />
        }
        trailing={
          <span className="flex items-center gap-2">
            <UndoButton canUndo={canUndo} onUndo={undo} />
            {!execution && (
              <button
                type="button"
                onClick={handleReplan}
                className="cursor-pointer font-mono text-[10px] text-text-muted hover:text-accent-light hover:underline"
              >
                Re-plan
              </button>
            )}
            <CopyButton text={plan} />
          </span>
        }
      />

      {saveError && <p className="mb-2 text-[11px] text-danger">{saveError}</p>}
      <div className="rounded-md border border-border bg-surface-raised/40 p-3">
        <Markdown className="text-[12.5px] leading-relaxed text-text-secondary">
          {plan}
        </Markdown>
      </div>

      <div className="mt-3">
        {execution ? (
          <PhaseCard tone="done" title="Completed">
            <Markdown className="text-[12.5px] leading-relaxed text-text-secondary">
              {execution}
            </Markdown>
          </PhaseCard>
        ) : !started ? (
          <PhaseCard tone="planned" title="Ready to implement">
            <p className="mb-3 text-[12.5px] text-text-secondary">
              Plan saved. Start implementation to claim this task and begin
              tracking execution.
            </p>
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={handleStartImpl}
            >
              {saving ? "Starting…" : "Start implementation"}
            </Button>
          </PhaseCard>
        ) : (
          <PhaseCard tone="progress" title="In progress">
            <p className="mb-2 text-[12.5px] text-text-secondary">
              Record the result after implementing this task.
            </p>
            <textarea
              value={executionInput}
              onChange={(e) => setExecutionInput(e.target.value)}
              placeholder="Paste the final output, PR link, notes…"
              rows={5}
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-[11.5px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent"
            />
            <Button
              variant="primary"
              size="sm"
              className="mt-2"
              disabled={saving}
              onClick={handleMarkDone}
            >
              {saving ? "Saving…" : "Mark as done"}
            </Button>
          </PhaseCard>
        )}
      </div>
    </section>
  );
}

interface UnmetDepsHintProps {
  /** Open upstream tasks. */
  deps: { id: string; title: string; taskRef: string }[];
}

/**
 * Mono hint surfacing upstream tasks that haven't reached `done` yet — drops
 * the user a soft warning before they push planning forward.
 *
 * @param props - Unmet deps.
 * @returns Compact callout.
 */
function UnmetDepsHint({ deps }: UnmetDepsHintProps) {
  return (
    <div className="rounded-md border border-progress/25 bg-progress/8 p-2.5">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-progress">
        Unmet dependencies
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {deps.map((d) => (
          <li
            key={d.id}
            className="flex items-baseline gap-2 text-[12px] text-text-secondary"
          >
            <span className="font-mono text-[10px] text-progress/70 tabular-nums">
              {d.taskRef}
            </span>
            <span>{d.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface PhaseBadgeProps {
  /** Badge label text. */
  label: string;
  /** Tone keyed to status palette. */
  tone: "draft" | "planned" | "progress" | "done";
}

/**
 * Tiny mono badge used in the plan-section header.
 *
 * @param props - Badge configuration.
 * @returns Inline badge element.
 */
function PhaseBadge({ label, tone }: PhaseBadgeProps) {
  const map = {
    draft: {
      fg: "text-text-muted",
      bg: "bg-text-muted/10",
      border: "border-text-muted/20",
    },
    planned: {
      fg: "text-planned",
      bg: "bg-planned/10",
      border: "border-planned/25",
    },
    progress: {
      fg: "text-progress",
      bg: "bg-progress/10",
      border: "border-progress/25",
    },
    done: { fg: "text-done", bg: "bg-done/10", border: "border-done/25" },
  } as const;
  const cls = map[tone];
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wider ${cls.bg} ${cls.fg} ${cls.border}`}
    >
      {label}
    </span>
  );
}

interface PhaseCardProps {
  /** Tone keyed to status palette. */
  tone: "planned" | "progress" | "done";
  /** Card title. */
  title: string;
  /** Card body. */
  children: React.ReactNode;
}

/**
 * Bordered card surfacing the phase-specific action set. Switches its
 * accent palette per status so the next-step CTA reads at a glance.
 *
 * @param props - Card configuration.
 * @returns Card element.
 */
function PhaseCard({ tone, title, children }: PhaseCardProps) {
  const map = {
    planned: {
      ring: "border-planned/20",
      bg: "bg-planned/5",
      fg: "text-planned",
    },
    progress: {
      ring: "border-progress/20",
      bg: "bg-progress/5",
      fg: "text-progress",
    },
    done: { ring: "border-done/20", bg: "bg-done/5", fg: "text-done" },
  } as const;
  const cls = map[tone];
  return (
    <div className={`rounded-md border ${cls.ring} ${cls.bg} p-3`}>
      <div className="mb-2 flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${cls.fg.replace("text-", "bg-")}`}
        />
        <span className={`text-[13px] font-semibold ${cls.fg}`}>{title}</span>
      </div>
      {children}
    </div>
  );
}

export default PlanSection;
