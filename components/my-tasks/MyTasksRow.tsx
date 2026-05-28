"use client";

import Link from "next/link";
import { memo } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { CategoryDot } from "@/components/shared/CategoryDot";
import { DepsHint } from "@/components/shared/DepsHint";
import { MonoId, type MonoIdTone } from "@/components/shared/MonoId";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import { ProjectMark } from "@/components/shared/ProjectMark";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { IconArrowRight, IconChevronRight } from "@/components/shared/icons";
import type { MyTask } from "@/lib/data/views";
import { formatRelative } from "@/components/workspace/structure/relativeTime";
import { TaskStatePill } from "./TaskStatePill";

interface MyTasksRowProps {
  row: MyTask;
  meName: string;
}

function titleClass(state: MyTask["state"]): string {
  if (state === "cancelled") return "text-text-muted line-through";
  if (state === "done") return "text-text-muted";
  return "text-text-primary";
}

// Whole row is a `<Link>` so middle-click and right-click work without JS.
function MyTasksRowImpl({ row, meName }: MyTasksRowProps) {
  return (
    <Link
      href={`/project/${row.project.id}?task=${row.id}`}
      data-task-id={row.id}
      className="group relative flex h-[34px] cursor-pointer items-center gap-2.5 border-b border-border pl-4 pr-2 transition-colors duration-100 hover:bg-surface-raised/40"
    >
      <StatusGlyph
        status={row.state}
        size={14}
        className={row.state === "in_progress" ? "status-pulse" : undefined}
      />
      <span className="hidden shrink-0 sm:inline-flex">
        <ProjectMark
          initial={(row.project.identifier[0] ?? "?").toUpperCase()}
          color={row.project.color}
          size={16}
        />
      </span>
      <MonoId
        id={row.taskRef}
        tone={row.state as MonoIdTone}
        dim={row.state === "done" || row.state === "cancelled"}
        copyable={false}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[13px] font-medium ${titleClass(row.state)}`}
      >
        {row.title}
      </span>

      {row.blockedBy && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums text-glyph-blocked"
          title={`Blocked by ${row.blockedBy}`}
        >
          <IconArrowRight size={9} />
          {row.blockedBy}
        </span>
      )}

      {row.upstreamCount > 0 && (
        <DepsHint icon="up" count={row.upstreamCount} />
      )}
      {row.downstreamCount > 0 && (
        <DepsHint icon="down" count={row.downstreamCount} />
      )}

      {row.category && <CategoryDot name={row.category} />}

      <span className="hidden shrink-0 sm:inline-flex">
        <TaskStatePill state={row.state} />
      </span>

      {row.priority && (
        <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center">
          <PriorityIcon priority={row.priority} />
        </span>
      )}

      <span
        className="-ml-1 inline-block min-w-[24px] shrink-0 text-right font-mono text-[10px] tabular-nums text-text-faint"
        title={`Last updated ${formatRelative(row.updatedAt)}`}
      >
        {formatRelative(row.updatedAt)}
      </span>

      <span className="inline-flex shrink-0 items-center">
        <Avatar name={meName} size={18} accent />
      </span>

      <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center text-text-faint opacity-0 transition-[opacity,transform,color] duration-150 -translate-x-1 group-hover:translate-x-0 group-hover:text-accent-light group-hover:opacity-100">
        <IconChevronRight size={11} />
      </span>
    </Link>
  );
}

export const MyTasksRow = memo(MyTasksRowImpl);
