"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { MonoId, type MonoIdTone } from "@/components/shared/MonoId";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import { ProjectMark } from "@/components/shared/ProjectMark";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { IconArrowRight } from "@/components/shared/icons";
import type { MyTask } from "@/lib/data/views";
import { formatRelative } from "@/components/workspace/structure/relativeTime";

interface PickupBannerProps {
  task: MyTask;
}

export function PickupBanner({ task }: PickupBannerProps) {
  const eyebrow =
    task.state === "in_progress"
      ? "PICK UP WHERE YOU LEFT OFF"
      : "READY TO PICK UP";

  const relativeUpdated = formatRelative(task.updatedAt);
  const updatedLabel =
    relativeUpdated === "now"
      ? "updated just now"
      : `updated ${relativeUpdated} ago`;

  return (
    <Link
      href={`/project/${task.project.id}?task=${task.id}`}
      className="mt-5 mb-6 block no-underline"
    >
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="group relative flex items-center gap-3 overflow-hidden rounded-xl border border-accent/20 bg-surface py-3.5 pl-5 pr-4 shadow-[var(--shadow-card)] transition-all duration-150 hover:-translate-y-px hover:border-accent/30 hover:shadow-[var(--shadow-card-hover)]"
        style={{
          backgroundImage:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 7%, transparent), color-mix(in srgb, var(--color-accent-2) 4%, transparent))",
        }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: "var(--color-accent-grad)" }}
        />
        <span className="ml-1 inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px] border border-border-strong bg-surface-raised text-accent-light">
          <StatusGlyph
            status={task.state}
            size={18}
            className={
              task.state === "in_progress" ? "status-pulse" : undefined
            }
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
            <span>{updatedLabel}</span>
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised/80 px-3 py-1 text-[12px] font-medium text-text-primary shadow-[var(--shadow-button)] transition-colors group-hover:border-accent/40 sm:inline-flex">
          Open
          <IconArrowRight size={12} />
        </span>
      </motion.div>
    </Link>
  );
}
