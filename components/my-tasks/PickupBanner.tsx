"use client";

import Link from "next/link";
import { MonoId, type MonoIdTone } from "@/components/shared/MonoId";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import { ProjectMark } from "@/components/shared/ProjectMark";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { IconArrowRight } from "@/components/shared/icons";
import type { MyTask } from "@/lib/data/views";
import { formatRelative } from "@/components/workspace/structure/relativeTime";

interface PickupBannerProps {
  /** Task selected by `pickPickupTask`. */
  task: MyTask;
}

/**
 * Hero strip suggesting the next task to pick up. Selection happens
 * upstream via `pickPickupTask` (urgent in-progress → core ready → any
 * ready → null). The eyebrow text keys off the chosen task's state.
 * Whole banner navigates to `/project/${id}?task=${ref}`.
 *
 * @param props - Selected task.
 * @returns Clickable banner element.
 */
export function PickupBanner({ task }: PickupBannerProps) {
  const eyebrow =
    task.state === "in_progress"
      ? "PICK UP WHERE YOU LEFT OFF"
      : "READY TO PICK UP";

  return (
    <Link
      href={`/project/${task.project.id}?task=${task.id}`}
      className="group relative mt-5 mb-[22px] flex items-center gap-3 rounded-[10px] border border-accent/20 bg-surface py-3.5 pl-[22px] pr-4 shadow-[var(--shadow-card)] transition-all duration-150 hover:-translate-y-px hover:border-accent/30 hover:shadow-[var(--shadow-card-hover)]"
      style={{
        backgroundImage:
          "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 7%, transparent), color-mix(in srgb, var(--color-accent-2) 4%, transparent))",
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-[10px]"
        style={{ background: "var(--color-accent-grad)" }}
      />
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-raised text-accent-light shadow-[var(--shadow-button)]">
        <StatusGlyph
          status={task.state}
          size={18}
          className={task.state === "in_progress" ? "status-pulse" : undefined}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-light">
          {eyebrow}
        </span>
        <span className="truncate text-[14.5px] font-medium leading-[1.35] text-text-primary">
          {task.title}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-muted">
          <ProjectMark
            initial={(task.project.identifier[0] ?? "?").toUpperCase()}
            color={task.project.color}
            size={12}
          />
          <span className="text-text-secondary">{task.project.title}</span>
          <span aria-hidden="true">·</span>
          <MonoId
            id={task.taskRef}
            tone={task.state as MonoIdTone}
            copyable={false}
          />
          {task.priority && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <PriorityIcon priority={task.priority} />
                <span className="capitalize">{task.priority}</span>
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>updated {formatRelative(task.updatedAt)} ago</span>
          {task.agentActive && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 text-accent-2">
                <span
                  aria-hidden="true"
                  className="status-pulse inline-block h-[5px] w-[5px] rounded-full bg-accent-2"
                />
                agent running
              </span>
            </>
          )}
        </span>
      </span>
      <span className="relative inline-flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-md border border-border-strong bg-surface-raised px-3.5 text-[12px] font-medium text-text-primary shadow-[var(--shadow-button)] transition-colors duration-150 group-hover:border-transparent group-hover:text-base">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          style={{ background: "var(--color-accent-grad)" }}
        />
        <span className="relative">Open</span>
        <span className="relative">
          <IconArrowRight size={12} />
        </span>
      </span>
    </Link>
  );
}
