"use client";

import { ProjectMark } from "@/components/shared/ProjectMark";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { IconChevronDown } from "@/components/shared/icons";
import type { TaskState } from "@/lib/data/task";

export type MyTasksGroupProps =
  | {
      kind: "status";
      state: TaskState;
      count: number;
      collapsed: boolean;
      onToggle: (() => void) | null;
    }
  | {
      kind: "project";
      projectIdentifier: string;
      projectTitle: string;
      projectColor: string;
      count: number;
    };

// `onToggle: null` locks a status group open.
export function MyTasksGroup(props: MyTasksGroupProps) {
  if (props.kind === "project") {
    return (
      <div className="sticky top-0 z-10 flex h-[30px] w-full items-center gap-2 border-b border-border bg-surface/70 px-3.5 backdrop-blur">
        <ProjectMark
          initial={(props.projectIdentifier[0] ?? "?").toUpperCase()}
          color={props.projectColor}
          size={14}
        />
        <span className="truncate text-[12px] font-medium text-text-secondary">
          {props.projectTitle}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">
          {props.count}
        </span>
      </div>
    );
  }

  const meta = STATUS_META[props.state];
  const content = (
    <>
      {props.onToggle && (
        <span
          aria-hidden="true"
          className="inline-flex text-text-muted transition-transform duration-150"
          style={{ transform: props.collapsed ? "rotate(-90deg)" : "none" }}
        >
          <IconChevronDown size={9} />
        </span>
      )}
      <StatusGlyph status={props.state} size={11} />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
        {meta.label}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-text-muted">
        {props.count}
      </span>
    </>
  );

  if (props.onToggle) {
    return (
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!props.collapsed}
        className="sticky top-0 z-10 flex h-[30px] w-full cursor-pointer items-center gap-2 border-b border-border bg-surface/70 px-3.5 backdrop-blur transition-colors hover:bg-surface-hover/70"
      >
        {content}
      </button>
    );
  }
  return (
    <div className="sticky top-0 z-10 flex h-[30px] w-full items-center gap-2 border-b border-border bg-surface/70 px-3.5 backdrop-blur">
      {content}
    </div>
  );
}
