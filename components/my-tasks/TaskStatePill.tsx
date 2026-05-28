import { STATUS_META } from "@/components/shared/StatusGlyph";
import type { TaskState } from "@/lib/data/task";
import { taskStateToneClass } from "./predicates";

interface TaskStatePillProps {
  state: TaskState;
}

export function TaskStatePill({ state }: TaskStatePillProps) {
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center justify-center rounded px-1.5 font-mono text-[9.5px] font-medium lowercase tracking-[0.02em] ${taskStateToneClass(state)}`}
    >
      {STATUS_META[state].label}
    </span>
  );
}
