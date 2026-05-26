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
import {
  IconAgent,
  IconArrowRight,
  IconChevronRight,
} from "@/components/shared/icons";
import type { MyTask } from "@/lib/data/views";
import { formatRelative } from "@/components/workspace/structure/relativeTime";
import { LifecycleStagePill } from "./LifecycleStagePill";

interface MyTasksRowProps {
  /** Row payload — see {@link MyTask}. */
  row: MyTask;
  /** Display name for the signed-in user's avatar slot. */
  meName: string;
}

/**
 * Format the title with the right de-emphasis for non-active states.
 *
 * @param state - Derived task state.
 * @returns Tailwind class string.
 */
function titleClass(state: MyTask["state"]): string {
  if (state === "cancelled") return "text-text-muted line-through";
  if (state === "done") return "text-text-muted";
  return "text-text-primary";
}

/**
 * 34px cross-project row used inside `<MyTasksList>`. Renders the slots
 * specified by DESIGN.md § 6b: glyph, ProjectMark, MonoId, title, agent
 * badge, blocked-by chip, deps hints, category dot, lifecycle stage pill,
 * priority, last-touched timestamp, signed-in user avatar, and a
 * chevron-on-hover. The whole row is a `<Link>` so middle-click and
 * right-click work without extra JS.
 *
 * @param props - Row payload + signed-in user's display name.
 * @returns Linked row element.
 */
function MyTasksRowImpl({ row, meName }: MyTasksRowProps) {
  return (
    <Link
      href={`/project/${row.project.id}?task=${row.taskRef}`}
      data-task-id={row.id}
      className="group relative flex h-[34px] cursor-pointer items-center gap-2.5 border-b border-border pl-4 pr-2 transition-colors duration-100 hover:bg-surface-raised/40"
    >
      <StatusGlyph
        status={row.state}
        size={14}
        className={row.state === "in_progress" ? "status-pulse" : undefined}
      />
      <ProjectMark
        initial={(row.project.identifier[0] ?? "?").toUpperCase()}
        color={row.project.color}
        size={16}
      />
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

      {row.agentActive && (
        <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-accent-2/24 bg-accent-2/12 px-1.5 text-accent-2">
          <span
            aria-hidden="true"
            className="status-pulse inline-block h-[5px] w-[5px] rounded-full bg-accent-2"
          />
          <IconAgent size={10} />
        </span>
      )}

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

      <LifecycleStagePill stage={row.stage} />

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
